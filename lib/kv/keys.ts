/**
 * Every KV key used by the app, in one place.
 *
 * Rules this module exists to enforce:
 *  - Primary records live at ["<entity>", id]. Secondary indexes store a
 *    *pointer* (the id), never a copy of the record.
 *  - Nothing outside this file builds a raw key array, so a schema change is a
 *    single-file edit and the type checker finds every caller.
 */

/**
 * `pending_confirm` is a promoted waitlister who has been offered a seat but
 * has not accepted yet. The seat is held — it blocks other joins — but it is
 * not a confirmed seat and does not enter the cost split.
 */
export type SignupStatus =
  | "confirmed"
  | "pending_confirm"
  | "waitlisted"
  | "cancelled"
  | "no_show"
  | "attended";

/** Fixed-width sequence so KV's lexicographic ordering matches numeric order. */
export function seqKey(n: number): string {
  return n.toString().padStart(10, "0");
}

/**
 * Leaderboard sort key. KV lists ascending, so we store the inverse of win
 * percentage to get descending order for free. Padded for lexicographic sort.
 */
export function winRateSortKey(winPct: number): string {
  const inverted = Math.round((100 - winPct) * 100);
  return inverted.toString().padStart(6, "0");
}

export const keys = {
  // ---- Identity -----------------------------------------------------------
  user: (userId: string) => ["user", userId] as const,
  userByEmail: (emailLower: string) => ["user_by_email", emailLower] as const,
  userByPhone: (e164: string) => ["user_by_phone", e164] as const,
  photo: (userId: string) => ["photo", userId] as const,

  session: (sessionId: string) => ["session", sessionId] as const,
  sessionsByUser: (userId: string, sessionId: string) =>
    ["sessions_by_user", userId, sessionId] as const,
  /** Key is a hash of the token; the raw token is never stored. */
  magicToken: (tokenHash: string) => ["magic_token", tokenHash] as const,
  /** Rate-limit counter, bucketed by time window and self-expiring. */
  rate: (scope: string, subject: string, windowStart: number) =>
    ["rate", scope, subject, windowStart] as const,

  // ---- Groups -------------------------------------------------------------
  group: (groupId: string) => ["group", groupId] as const,
  groupBySlug: (slug: string) => ["group_by_slug", slug] as const,
  member: (groupId: string, userId: string) =>
    ["member", groupId, userId] as const,
  membersByUser: (userId: string, groupId: string) =>
    ["members_by_user", userId, groupId] as const,

  // ---- Games --------------------------------------------------------------
  game: (gameId: string) => ["game", gameId] as const,
  gamesByGroup: (groupId: string, startUtc: string, gameId: string) =>
    ["games_by_group", groupId, startUtc, gameId] as const,
  /** Public listing only. Unlisted and password games are excluded. */
  gamesOpen: (startUtc: string, gameId: string) =>
    ["games_open", startUtc, gameId] as const,
  gameBySlug: (slug: string) => ["game_by_slug", slug] as const,
  /** Remembers that a user already cleared a game's join password. */
  gamePasswordOk: (gameId: string, userId: string) =>
    ["game_pw_ok", gameId, userId] as const,

  // ---- Signups ------------------------------------------------------------
  signup: (gameId: string, userId: string) =>
    ["signup", gameId, userId] as const,
  /**
   * Roster and ordered waitlist. Status is part of the key, so a status change
   * means delete-then-set within one atomic commit.
   */
  signupsByGame: (gameId: string, status: SignupStatus, seq: string) =>
    ["signups_by_game", gameId, status, seq] as const,
  signupsByGamePrefix: (gameId: string, status: SignupStatus) =>
    ["signups_by_game", gameId, status] as const,
  signupsByUser: (userId: string, startUtc: string) =>
    ["signups_by_user", userId, startUtc] as const,
  /** Monotonic waitlist counter, incremented with atomic sum, never max+1. */
  waitlistSeq: (gameId: string) => ["waitlist_seq", gameId] as const,

  // ---- Matches and stats --------------------------------------------------
  match: (matchId: string) => ["match", matchId] as const,
  matchesByUser: (userId: string, ts: string, matchId: string) =>
    ["matches_by_user", userId, ts, matchId] as const,
  matchesByGame: (gameId: string, matchId: string) =>
    ["matches_by_game", gameId, matchId] as const,
  matchesByGamePrefix: (gameId: string) => ["matches_by_game", gameId] as const,
  stats: (groupId: string, userId: string) =>
    ["stats", groupId, userId] as const,
  /**
   * Every player's record in one group.
   *
   * The leaderboard scans this and sorts in memory rather than maintaining a
   * sorted index. A club is tens of players, and an index would have to delete
   * its old sort-key entry and write a new one atomically on every stats
   * change — real complexity, bought for nothing at this size.
   */
  statsByGroupPrefix: (groupId: string) => ["stats", groupId] as const,

  // ---- Audit --------------------------------------------------------------
  /** Scoped by group so an organizer's reads can never span groups. */
  audit: (scope: string, ts: string, seq: string) =>
    ["audit", scope, ts, seq] as const,
} as const;
