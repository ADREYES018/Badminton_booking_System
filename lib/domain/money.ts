/**
 * Money. Integer fils only — 1 AED = 100 fils. No float ever touches a total.
 *
 * The organizer prices a seat outright. There is no split, no divisor and no
 * estimate that moves as the roster fills: what a player is quoted when they
 * join is what they owe. A guest seat costs the same as a player's.
 */

import type { Game, Signup } from "../types.ts";

export const FILS_PER_AED = 100;

export function aedToFils(aed: number): number {
  return Math.round(aed * FILS_PER_AED);
}

/** Formats fils for display, e.g. 3500 -> "AED 35" and 3550 -> "AED 35.50". */
export function formatFils(fils: number): string {
  const negative = fils < 0;
  const abs = Math.abs(fils);
  const whole = Math.floor(abs / FILS_PER_AED);
  const part = abs % FILS_PER_AED;
  const body = part === 0
    ? `${whole}`
    : `${whole}.${part.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}AED ${body}`;
}

/**
 * How many seats the game has.
 *
 * The organizer states this outright. It used to be `courts × playersPerCourt`,
 * which tied the roster size to an even split across courts; the two are now
 * independent, so this is a read rather than a calculation.
 */
export function capacityOf(game: Pick<Game, "maxPlayers">) {
  return game.maxPlayers;
}

/**
 * Seats consumed. A guest occupies a seat regardless of how they are priced,
 * and a seat held by a promoted player who has not accepted yet is occupied
 * too — it is exactly what stops the next person taking it.
 *
 * This is the capacity question, not the billing question. `splitCost` uses a
 * narrower divisor; see the note on `Game.confirmedCount`.
 */
export function seatsTaken(
  game: Pick<Game, "confirmedCount" | "pendingCount" | "guestCount">,
): number {
  return game.confirmedCount + game.pendingCount + game.guestCount;
}

export function seatsRemaining(
  game: Pick<
    Game,
    "maxPlayers" | "confirmedCount" | "pendingCount" | "guestCount"
  >,
): number {
  return Math.max(0, capacityOf(game) - seatsTaken(game));
}

/**
 * What one signup owes: their own seat plus their guests', at the game's
 * price.
 *
 * A signup that was already billed keeps that figure. The roster freezes at
 * the cutoff and stamps `owedFils` on every confirmed player, and an organizer
 * who edits the price afterwards must not silently re-bill people who joined
 * under the old one — they agreed to a number, and that number is what stands.
 */
export function amountOwed(
  signup: Pick<Signup, "guests" | "owedFils">,
  game: Pick<Game, "pricePerPlayerFils">,
): number {
  if (signup.owedFils !== undefined) return signup.owedFils;
  return game.pricePerPlayerFils * (1 + signup.guests.length);
}

/** The total an organizer collects if everyone currently on the roster pays. */
export function expectedTakeFils(
  game: Pick<
    Game,
    "pricePerPlayerFils" | "confirmedCount" | "guestCount"
  >,
): number {
  return game.pricePerPlayerFils * (game.confirmedCount + game.guestCount);
}
