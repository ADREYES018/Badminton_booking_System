/**
 * Sign-in codes, sessions, and rate limiting.
 *
 * There are no passwords anywhere in this app. A login is: prove you can read
 * an inbox, receive a session cookie.
 *
 * The proof is a six-digit code rather than a link. A link in an email is
 * fetched by the mail provider before its recipient ever sees it — to scan it,
 * to preview it — and a single-use link is spent by that fetch. A code cannot
 * be followed, so nothing can spend it on the reader's behalf.
 *
 * Codes are stored hashed with a KV `expireIn`, so they self-delete and a
 * database dump never yields anything that can be typed in. Being short, they
 * are also guessable in a way a 32-byte token was not, so wrong answers are
 * counted and the code is destroyed once the allowance runs out.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import { getRecord } from "../kv/kv.ts";
import type { MagicToken, Session, User } from "../types.ts";
import { sha256Hex, timingSafeEqual } from "../crypto.ts";
import { normalizeEmail } from "../domain/validate.ts";
import { nowIso } from "../domain/time.ts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MAGIC_TOKEN_TTL_MS = 15 * MINUTE_MS;
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Sessions refresh when this much of their life has elapsed. */
const SESSION_REFRESH_AFTER_MS = 7 * DAY_MS;

export const SESSION_COOKIE = "sc_session";

/** Wrong guesses a code survives before it is destroyed. */
export const MAX_CODE_ATTEMPTS = 5;

export const CODE_LENGTH = 6;

export interface IssuedToken {
  /** The code, emailed to the user. Never stored in the clear. */
  code: string;
  expiresAt: string;
}

/**
 * Six digits from the system's cryptographic source.
 *
 * Rejection sampling rather than a modulo of one random value: the low bits of
 * a bounded range are not uniform under modulo, and a login code with
 * predictable digits is worth less than its length suggests.
 */
function randomCode(): string {
  const max = 10 ** CODE_LENGTH;
  const limit = Math.floor(0xffffffff / max) * max;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);
  return (value % max).toString().padStart(CODE_LENGTH, "0");
}

/**
 * Issues a sign-in code for an address, replacing any code already pending for
 * it — asking again should invalidate the previous email rather than leave two
 * codes live.
 */
export async function issueMagicToken(
  kv: Deno.Kv,
  email: string,
  options: { ip?: string; redirectTo?: string } = {},
): Promise<IssuedToken> {
  const code = randomCode();
  const emailLower = normalizeEmail(email);
  const record: MagicToken = {
    v: 1,
    email: email.trim(),
    emailLower,
    codeHash: await sha256Hex(code),
    ip: options.ip,
    createdAt: nowIso(),
    redirectTo: options.redirectTo,
    attempts: 0,
  };

  await kv.set(keys.magicToken(emailLower), record, {
    expireIn: MAGIC_TOKEN_TTL_MS,
  });

  return {
    code,
    expiresAt: new Date(Date.now() + MAGIC_TOKEN_TTL_MS).toISOString(),
  };
}

/** Whether a code was accepted, and if not, why. */
export type CodeResult =
  | { ok: true; claim: MagicToken }
  | { ok: false; reason: "unknown" | "wrong" | "exhausted" };

/**
 * Checks a code against the one pending for an address.
 *
 * Right answer: the record is deleted in the same commit that reads it, so two
 * submissions of the same code cannot both open a session.
 *
 * Wrong answer: the attempt is counted, and the code is destroyed once the
 * allowance runs out. Six digits is a million combinations — survivable to
 * guess only if guessing is unlimited, which is exactly what the counter
 * removes. A miscount from a lost race would let the attacker have the attempt
 * for free, so the increment is checked against the read like everything else.
 */
export async function verifyLoginCode(
  kv: Deno.Kv,
  email: string,
  code: string,
): Promise<CodeResult> {
  const emailLower = normalizeEmail(email);
  const key = keys.magicToken(emailLower);
  const entry = await getRecord<MagicToken>(kv, key);
  const pending = entry.value;
  if (!pending) return { ok: false, reason: "unknown" };

  const submitted = await sha256Hex(code.trim());
  if (timingSafeEqual(submitted, pending.codeHash)) {
    const claimed = await kv.atomic().check(entry).delete(key).commit();
    // Lost the race, so another request already signed in with this code.
    if (!claimed.ok) return { ok: false, reason: "unknown" };
    return { ok: true, claim: pending };
  }

  const attempts = pending.attempts + 1;
  if (attempts >= MAX_CODE_ATTEMPTS) {
    await kv.atomic().check(entry).delete(key).commit();
    return { ok: false, reason: "exhausted" };
  }

  // Preserve whatever life the code had left rather than resetting its window.
  const elapsed = Date.now() - new Date(pending.createdAt).getTime();
  await kv.atomic()
    .check(entry)
    .set(key, { ...pending, attempts }, {
      expireIn: Math.max(MAGIC_TOKEN_TTL_MS - elapsed, 1000),
    })
    .commit();

  return { ok: false, reason: "wrong" };
}

/** The code pending for an address, for tests and for the resend guard. */
export async function peekMagicToken(
  kv: Deno.Kv,
  email: string,
): Promise<MagicToken | null> {
  const entry = await getRecord<MagicToken>(
    kv,
    keys.magicToken(normalizeEmail(email)),
  );
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
