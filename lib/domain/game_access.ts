/**
 * Who may see a game, and who may take a seat in it.
 *
 * Club membership used to answer both questions: a game belonged to a club,
 * and being in the club was what let you play. That gate is gone — games are
 * browsed across every club, and anyone signed in can join one — so the two
 * questions are now answered per game rather than per club.
 *
 * What remains is the organizer's own choice of who they want:
 *
 *   public    anyone signed in may see it and join it
 *   password  anyone may see it; only a six-digit code takes a seat
 *   unlisted  only someone holding the URL sees it at all
 *
 * The unlock is recorded per player rather than held in a cookie, so entering
 * the code once carries across devices and cannot be replayed from a stale
 * browser after an organizer changes it.
 */

import { keys } from "../kv/keys.ts";
import { timingSafeEqual } from "../crypto.ts";
import type { Game } from "../types.ts";

/** Records that this player got the code right, so they are not asked twice. */
export async function recordUnlock(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<void> {
  await kv.set(keys.gamePasswordOk(gameId, userId), true);
}

/**
 * Whether this player may take a seat.
 *
 * An organizer is never locked out of their own game, and a public game asks
 * nothing of anyone. Everything else needs a recorded unlock.
 */
export async function hasUnlocked(
  kv: Deno.Kv,
  game: Pick<Game, "id" | "visibility">,
  userId: string,
  isOrganizer = false,
): Promise<boolean> {
  if (game.visibility !== "password") return true;
  if (isOrganizer) return true;
  const entry = await kv.get<boolean>(keys.gamePasswordOk(game.id, userId));
  return entry.value === true;
}

/**
 * Checks a submitted code against the game's.
 *
 * Compared in constant time. Six digits is a small enough space that a timing
 * side channel would meaningfully narrow it, and the comparison costs nothing.
 */
export function codeMatches(
  game: Pick<Game, "joinCode">,
  submitted: string,
): boolean {
  if (!game.joinCode) return false;
  return timingSafeEqual(game.joinCode, submitted.trim());
}
