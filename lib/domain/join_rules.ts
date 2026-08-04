/**
 * Who may join a game, and what they should be warned about.
 *
 * Two distinct ideas live here and are kept apart on purpose:
 *
 *   a *block* is a server-enforced refusal — the join fails
 *   a *warning* is advisory — the UI says something, the join still succeeds
 *
 * Skill range is a warning. Organizers set ranges loosely and a club game with
 * an empty seat is better filled than left empty, so an out-of-range player is
 * told they are outside the suggested level and allowed to decide for
 * themselves. Time is a block: once a game has started there is nothing to
 * join.
 *
 * These are pure functions over records the caller already read. They never
 * touch KV, so the route layer and the data layer can both consult them
 * without a second round trip.
 */

import type { Game, Skill, User } from "../types.ts";
import { SKILL_ORDER } from "../types.ts";
import { seatsRemaining } from "./money.ts";

/** Reason a join was refused. `null` means the join may proceed. */
export type JoinBlock =
  | "not_open"
  | "already_started"
  | "cancelled"
  | "blocked_member";

export const JOIN_BLOCK_MESSAGES: Record<JoinBlock, string> = {
  not_open: "This game is not open for sign-ups.",
  already_started: "This game has already started.",
  cancelled: "This game was cancelled.",
  blocked_member: "You are blocked from this group.",
};

/**
 * Server-enforced gate. Returns the reason a join must be refused, or null.
 *
 * Note what is deliberately absent: a full roster is not a block. A player
 * joining a full game goes to the waitlist, which is a successful join with a
 * different outcome, decided in `signups.ts` against fresh counts.
 */
export function joinBlock(
  game: Pick<Game, "status" | "startUtc">,
  now: Date = new Date(),
): JoinBlock | null {
  if (game.status === "cancelled") return "cancelled";
  if (game.status === "draft" || game.status === "completed") return "not_open";
  if (now >= new Date(game.startUtc)) return "already_started";
  return null;
}

export function canJoin(
  game: Pick<Game, "status" | "startUtc">,
  now: Date = new Date(),
): boolean {
  return joinBlock(game, now) === null;
}

/**
 * Advisory skill note, or null when the player is within range.
 *
 * Phrased as guidance rather than a refusal, because that is what it is.
 */
export function skillWarning(
  game: Pick<Game, "skillMin" | "skillMax">,
  user: Pick<User, "skill">,
): string | null {
  const rank = (skill: Skill) => SKILL_ORDER.indexOf(skill);
  const playerRank = rank(user.skill);

  if (game.skillMin && playerRank < rank(game.skillMin)) {
    return `This game is aimed at ${game.skillMin} level and above. ` +
      `You can still join — expect a faster game than usual.`;
  }

  if (game.skillMax && playerRank > rank(game.skillMax)) {
    return `This game is aimed at ${game.skillMax} level and below. ` +
      `You can still join — expect a gentler game than usual.`;
  }

  return null;
}

/**
 * How many guests this player may still add.
 *
 * Bounded by both the organizer's per-player limit and the seats actually
 * left, since a guest occupies a real seat. The seat figure here is a live
 * estimate for the UI — the authoritative check happens inside the atomic
 * commit in `signups.ts`, because seats can vanish between render and submit.
 */
export function guestsAllowed(
  game: Pick<
    Game,
    | "maxGuestsPerPlayer"
    | "maxPlayers"
    | "confirmedCount"
    | "pendingCount"
    | "guestCount"
  >,
  currentGuests: number,
): number {
  const perPlayerLeft = Math.max(0, game.maxGuestsPerPlayer - currentGuests);
  return Math.min(perPlayerLeft, seatsRemaining(game));
}

/** True when the game has room right now; false means a join is waitlisted. */
export function hasRoom(
  game: Pick<
    Game,
    "maxPlayers" | "confirmedCount" | "pendingCount" | "guestCount"
  >,
  seatsWanted = 1,
): boolean {
  return seatsRemaining(game) >= seatsWanted;
}
