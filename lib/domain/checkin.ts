/**
 * Check-in tokens.
 *
 * A player displays one of these; the organizer's scanner reads it and posts
 * it. The token proves *this player* — it does not prove presence, because
 * nothing can, and a design claiming otherwise would be lying about what it
 * knows.
 *
 * One code per player, for every club and every game, forever. Phase 5 minted
 * one per game and expired it in minutes, which meant a code could not be
 * presented at a game it was not minted for. Nothing in the token enforces
 * that now, so the caller does: `POST /games/:slug/checkin` refuses a player
 * who is not confirmed on that game's roster. That check is what replaced
 * expiry, and without it this token would mark anyone present anywhere.
 *
 * A permanent code is worth screenshotting and will be screenshotted. The
 * version field is the remedy: bumping it retires one player's code without
 * touching anyone else's, where rotating the server secret would kill every
 * code at once.
 *
 * The organizer guard on `setAttendance` remains the actual access control.
 * These functions are pure and hold no KV handle, so the rules here can be
 * tested without a database.
 */

import { hmacHex, timingSafeEqual } from "../crypto.ts";
import type { User } from "../types.ts";

/** How many hex characters of the HMAC the token carries. */
const MAC_LENGTH = 16;

export class CheckinError extends Error {}

/** A record written before this phase has no version and counts as the first. */
export function checkinVersionOf(user: User): number {
  return user.checkinVersion ?? 1;
}

async function sign(userId: string, version: number): Promise<string> {
  // `v2` is inside the signed bytes, so no Phase 5 token can verify here even
  // by accident.
  const mac = await hmacHex(`checkin:v2:${userId}:${version}`);
  return mac.slice(0, MAC_LENGTH);
}

/**
 * The permanent code for one player.
 *
 * The user id travels in the clear. It is not a secret — every member can see
 * the roster — and carrying it means the scanner can name the player before
 * the server replies.
 */
export async function mintCheckinToken(
  userId: string,
  version = 1,
): Promise<string> {
  const mac = await sign(userId, version);
  return `${userId}.${version}.${mac}`;
}

export interface CheckinClaim {
  userId: string;
  version: number;
}

/**
 * Reads a token back, or refuses it.
 *
 * A valid claim means the code was minted by this server for this player at
 * this version. It says nothing about which game, or whether the version is
 * still current — the caller holds the user record needed to answer that.
 */
export async function verifyCheckinToken(
  token: string,
): Promise<CheckinClaim> {
  const parts = token.trim().split(".");
  // Phase 5 tokens carried four parts. Rejecting on count refuses them before
  // any signature is computed.
  if (parts.length !== 3) {
    throw new CheckinError("That is not a check-in code.");
  }

  const [userId, versionText, mac] = parts as [string, string, string];

  const version = Number(versionText);
  if (!Number.isInteger(version) || version < 1) {
    throw new CheckinError("That is not a check-in code.");
  }

  const expected = await sign(userId, version);
  if (!timingSafeEqual(mac, expected)) {
    throw new CheckinError("That code could not be verified.");
  }

  return { userId, version };
}
