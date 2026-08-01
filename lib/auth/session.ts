/**
 * Magic-link tokens, sessions, and rate limiting.
 *
 * There are no passwords anywhere in this app. A login is: prove you can read
 * an inbox, receive a session cookie.
 *
 * Tokens are stored hashed with a KV `expireIn`, so they self-delete and a
 * database dump never yields a working login link.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import { getRecord } from "../kv/kv.ts";
import type { MagicToken, Session, User } from "../types.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { normalizeEmail } from "../domain/validate.ts";
import { nowIso } from "../domain/time.ts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MAGIC_TOKEN_TTL_MS = 15 * MINUTE_MS;
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Sessions refresh when this much of their life has elapsed. */
const SESSION_REFRESH_AFTER_MS = 7 * DAY_MS;

export const SESSION_COOKIE = "sc_session";

export interface IssuedToken {
  /** The raw token, emailed to the user. Never stored. */
  token: string;
  expiresAt: string;
}

export async function issueMagicToken(
  kv: Deno.Kv,
  email: string,
  options: { ip?: string; redirectTo?: string } = {},
): Promise<IssuedToken> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const record: MagicToken = {
    v: 1,
    email: email.trim(),
    emailLower: normalizeEmail(email),
    ip: options.ip,
    createdAt: nowIso(),
    redirectTo: options.redirectTo,
  };

  await kv.set(keys.magicToken(hash), record, { expireIn: MAGIC_TOKEN_TTL_MS });

  return {
    token,
    expiresAt: new Date(Date.now() + MAGIC_TOKEN_TTL_MS).toISOString(),
  };
}

/**
 * Redeems a magic token. Single use: the delete is checked against the read, so
 * two clicks on the same link cannot both succeed.
 */
export async function consumeMagicToken(
  kv: Deno.Kv,
  token: string,
): Promise<MagicToken | null> {
  const hash = await sha256Hex(token);
  const entry = await getRecord<MagicToken>(kv, keys.magicToken(hash));
  if (!entry.value) return null;

  const deleted = await kv.atomic()
    .check(entry)
    .delete(keys.magicToken(hash))
    .commit();

  // Lost the race, so another request already redeemed this token.
  if (!deleted.ok) return null;
  return entry.value;
}

export async function createSession(
  kv: Deno.Kv,
  user: User,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<Session> {
  const session: Session = {
    v: 1,
    id: ulid(),
    userId: user.id,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 200),
  };

  await kv.atomic()
    .set(keys.session(session.id), session, { expireIn: SESSION_TTL_MS })
    .set(keys.sessionsByUser(user.id, session.id), session.id, {
      expireIn: SESSION_TTL_MS,
    })
    .commit();

  return session;
}

/**
 * Loads a session, rolling its expiry forward once it is over a week old.
 * Rolling on every request would rewrite the record on every page view.
 */
export async function getSession(
  kv: Deno.Kv,
  sessionId: string,
): Promise<Session | null> {
  const entry = await getRecord<Session>(kv, keys.session(sessionId));
  const session = entry.value;
  if (!session) return null;

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await destroySession(kv, session);
    return null;
  }

  const age = Date.now() - new Date(session.createdAt).getTime();
  if (age > SESSION_REFRESH_AFTER_MS) {
    const refreshed: Session = {
      ...session,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
    await kv.atomic()
      .check(entry)
      .set(keys.session(session.id), refreshed, { expireIn: SESSION_TTL_MS })
      .set(keys.sessionsByUser(session.userId, session.id), session.id, {
        expireIn: SESSION_TTL_MS,
      })
      .commit();
    return refreshed;
  }

  return session;
}

export async function destroySession(
  kv: Deno.Kv,
  session: Pick<Session, "id" | "userId">,
): Promise<void> {
  await kv.atomic()
    .delete(keys.session(session.id))
    .delete(keys.sessionsByUser(session.userId, session.id))
    .commit();
}

/** Signs every device out, for example after a role change. */
export async function destroyAllSessions(
  kv: Deno.Kv,
  userId: string,
): Promise<void> {
  const iter = kv.list<string>({ prefix: ["sessions_by_user", userId] });
  for await (const entry of iter) {
    if (entry.value) await kv.delete(keys.session(entry.value));
    await kv.delete(entry.key);
  }
}

export function sessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for the Retry-After header. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limit backed by a self-expiring KV counter.
 *
 * Good enough for the abuse this app faces — someone hammering the magic-link
 * form — without the bookkeeping a sliding window needs.
 */
export async function rateLimit(
  kv: Deno.Kv,
  scope: string,
  subject: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const key = keys.rate(scope, subject, windowStart);

  await kv.atomic().sum(key, 1n).commit();
  const entry = await kv.get<Deno.KvU64>(key);
  const count = Number(entry.value?.value ?? 1n);

  // Refresh the TTL so the counter disappears once its window has passed.
  if (count === 1) {
    await kv.set(key, new Deno.KvU64(1n), { expireIn: windowMs });
  }

  const resetAt = windowStart + windowMs;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.ceil((resetAt - Date.now()) / 1000),
  };
}

/** Per-email and per-IP limits on requesting a login link. */
export const LOGIN_RATE = {
  perEmail: { limit: 5, windowMs: 15 * MINUTE_MS },
  perIp: { limit: 20, windowMs: 15 * MINUTE_MS },
} as const;
