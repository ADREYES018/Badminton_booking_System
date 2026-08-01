/**
 * Request-scoped auth: session loading, CSRF, and role guards.
 *
 * Authorization is checked here on the server for every route. A hidden button
 * is not access control, and no route may rely on the UI having omitted a link.
 */

import type { Group, Membership, User } from "../types.ts";
import { getKv } from "../kv/kv.ts";
import { keys } from "../kv/keys.ts";
import { getRecord } from "../kv/kv.ts";
import { getSession, readSessionCookie } from "./session.ts";
import { getUser } from "../data/users.ts";
import { randomToken, timingSafeEqual } from "../crypto.ts";

export interface AuthState {
  kv: Deno.Kv;
  user: User | null;
  sessionId: string | null;
  csrfToken: string;
}

export const CSRF_COOKIE = "sc_csrf";
export const CSRF_FIELD = "_csrf";

/** Secure cookies break plain-HTTP local development. */
export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

export function csrfCookie(token: string, secure: boolean): string {
  // Readable by script so the client can echo it back; the secret is the
  // match between cookie and submitted field, not the value itself.
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    "Path=/",
    "SameSite=Lax",
    "Max-Age=86400",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/** Resolves the signed-in user, if any. Never throws on a bad cookie. */
export async function loadAuthState(req: Request): Promise<AuthState> {
  const kv = await getKv();
  const sessionId = readSessionCookie(req);
  const csrfToken = readCookie(req, CSRF_COOKIE) ?? randomToken(24);

  if (!sessionId) return { kv, user: null, sessionId: null, csrfToken };

  const session = await getSession(kv, sessionId);
  if (!session) return { kv, user: null, sessionId: null, csrfToken };

  const user = await getUser(kv, session.userId);
  return { kv, user, sessionId: session.id, csrfToken };
}

/**
 * Double-submit CSRF check: the submitted token must match the cookie.
 * Applied to every state-changing request.
 */
export function verifyCsrf(req: Request, submitted: string | null): boolean {
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!cookie || !submitted) return false;
  return timingSafeEqual(cookie, submitted);
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function requireUser(state: AuthState): User {
  if (!state.user) throw new HttpError(401, "Sign in to continue");
  return state.user;
}

export function requireSuperAdmin(state: AuthState): User {
  const user = requireUser(state);
  if (user.role !== "super_admin") {
    throw new HttpError(403, "You do not have access to this page");
  }
  return user;
}

export async function getMembership(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
): Promise<Membership | null> {
  const entry = await getRecord<Membership>(kv, keys.member(groupId, userId));
  return entry.value;
}

export interface GroupAccess {
  user: User;
  group: Group;
  membership: Membership | null;
  isOrganizer: boolean;
}

/**
 * Loads a group along with the caller's rights over it.
 *
 * A super_admin is treated as an organizer everywhere; otherwise organizer
 * rights come only from that specific group's membership. Cross-group access
 * is impossible by construction, since rights are read per group.
 */
export async function loadGroupAccess(
  state: AuthState,
  groupId: string,
): Promise<GroupAccess> {
  const user = requireUser(state);
  const groupEntry = await getRecord<Group>(state.kv, keys.group(groupId));
  const group = groupEntry.value;
  if (!group) throw new HttpError(404, "Group not found");

  const membership = await getMembership(state.kv, groupId, user.id);
  const isOrganizer = user.role === "super_admin" ||
    group.ownerId === user.id ||
    membership?.role === "organizer";

  return { user, group, membership, isOrganizer };
}

/** Throws unless the caller may administer this specific group. */
export async function requireOrganizer(
  state: AuthState,
  groupId: string,
): Promise<GroupAccess> {
  const access = await loadGroupAccess(state, groupId);
  if (!access.isOrganizer) {
    throw new HttpError(403, "Only organizers can do that");
  }
  return access;
}

/** Blocked members keep read access but may not RSVP. */
export function assertNotBlocked(membership: Membership | null): void {
  if (membership?.blocked) {
    const reason = membership.blockReason ? `: ${membership.blockReason}` : "";
    throw new HttpError(403, `You are blocked from this group${reason}`);
  }
}

/** Best-effort client IP, for rate limits and the audit trail. */
export function clientIp(req: Request): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim();
  return req.headers.get("x-real-ip") ?? undefined;
}
