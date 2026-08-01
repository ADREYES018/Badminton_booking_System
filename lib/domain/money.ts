/**
 * Money. Integer fils only — 1 AED = 100 fils. No float ever touches a total.
 *
 * Guest pricing is chosen per game by the organizer:
 *   full_share  guest counts in the divisor and splits equally with members
 *   flat_fee    guest pays a fixed fee, deducted from the pot before splitting
 *   free        guest is excluded and the members absorb their cost
 */

import type { Game, GuestPricing, Signup } from "../types.ts";

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

export function capacityOf(game: Pick<Game, "courts" | "playersPerCourt">) {
  return game.courts * game.playersPerCourt;
}

/** Seats consumed. A guest occupies a seat regardless of how they are priced. */
export function seatsTaken(
  game: Pick<Game, "confirmedCount" | "guestCount">,
): number {
  return game.confirmedCount + game.guestCount;
}

export function seatsRemaining(
  game: Pick<
    Game,
    "courts" | "playersPerCourt" | "confirmedCount" | "guestCount"
  >,
): number {
  return Math.max(0, capacityOf(game) - seatsTaken(game));
}

export interface CostSplit {
  /** What each confirmed member owes for themselves. */
  perHeadFils: number;
  /** What each guest owes. Zero when the members absorb the cost. */
  perGuestFils: number;
  /** Sum actually collectable. May exceed the cost because of rounding up. */
  totalCollectedFils: number;
}

/**
 * Splits a game's court cost across its confirmed members and guests.
 *
 * Rounding is always up, so the organizer is never left short; the surplus is
 * at most one fil per payer.
 */
export function splitCost(
  totalCostFils: number,
  confirmedCount: number,
  guestCount: number,
  pricing: GuestPricing,
): CostSplit {
  if (confirmedCount <= 0) {
    return { perHeadFils: 0, perGuestFils: 0, totalCollectedFils: 0 };
  }

  switch (pricing.mode) {
    case "full_share": {
      const divisor = confirmedCount + guestCount;
      const perHead = Math.ceil(totalCostFils / divisor);
      return {
        perHeadFils: perHead,
        perGuestFils: perHead,
        totalCollectedFils: perHead * divisor,
      };
    }

    case "flat_fee": {
      const guestContribution = pricing.feeFils * guestCount;
      // Guests may over-cover the pot; members still owe nothing below zero.
      const pot = Math.max(0, totalCostFils - guestContribution);
      const perHead = Math.ceil(pot / confirmedCount);
      return {
        perHeadFils: perHead,
        perGuestFils: pricing.feeFils,
        totalCollectedFils: perHead * confirmedCount + guestContribution,
      };
    }

    case "free": {
      const perHead = Math.ceil(totalCostFils / confirmedCount);
      return {
        perHeadFils: perHead,
        perGuestFils: 0,
        totalCollectedFils: perHead * confirmedCount,
      };
    }
  }
}

/** Live estimate, or the frozen figure once the roster has locked. */
export function currentSplit(game: Game): CostSplit {
  if (game.frozenPerHeadFils !== undefined) {
    const split = splitCost(
      game.totalCostFils,
      game.confirmedCount,
      game.guestCount,
      game.guestPricing,
    );
    return { ...split, perHeadFils: game.frozenPerHeadFils };
  }
  return splitCost(
    game.totalCostFils,
    game.confirmedCount,
    game.guestCount,
    game.guestPricing,
  );
}

/** What one signup owes in total: their own share plus their guests'. */
export function amountOwed(
  signup: Pick<Signup, "guests">,
  split: CostSplit,
): number {
  return split.perHeadFils + split.perGuestFils * signup.guests.length;
}
