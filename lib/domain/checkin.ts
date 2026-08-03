/**
 * Check-in tokens.
 *
 * A player displays one of these; the organizer's scanner reads it and posts
 * it. The token proves *this player, this game, recently* — it does not prove
 * presence, because nothing can, and a design claiming otherwise would be
 * lying about what it knows.
 *
 * What it does buy is that a code screenshotted and sent to an absent friend
 * the night before is useless, which is the realistic abuse. Anything stronger
 * (a code rotating every few seconds) trades a real failure mode — clock skew
 * at a venue with bad signal — for a marginal gain.
 *
 * The organizer guard on `setAttendance` is the actual access control. These
 * functions are pure and hold no KV handle, so the rules here can be tested
 * without a database.
 */

import { hmacHex, timingSafeEqual } from "../crypto.ts";

/**
 * Seconds per validity bucket.
 *
 * Verification accepts the current bucket and the one before it, so the window
 * a code is usable for is between five and ten minutes depending on where in
 * the bucket it was minted. Long enough to walk from the door to the desk,
 * short enough that a code shared earlier that day has expired.
 */
export const CHECKIN_WINDOW_SECONDS = 300;

/** How many hex characters of the HMAC the token carries. */
const MAC_LENGTH = 16;

export class CheckinError extends Error {}

/** The bucket an instant falls in. */
export function windowAt(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / CHECKIN_WINDOW_SECONDS);
}

async function sign(
  gameId: string,
  userId: string,
  window: number,
): Promise<string> {
  const mac = await hmacHex(`checkin:${gameId}:${userId}:${window}`);
  return mac.slice(0, MAC_LENGTH);
}

/**
 * A token for one player at one game, valid from now.
 *
 * The game and user ids travel in the clear. They are not secrets — the
 * roster is visible to every member — and carrying them means the scanner can
 * name the player before the server replies.
 */
export async function mintCheckinToken(
  gameId: string,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const window = windowAt(now);
  const mac = await sign(gameId, userId, window);
  return `${gameId}.${userId}.${window}.${mac}`;
}

export interface CheckinClaim {
  gameId: string;
  userId: string;
}

/**
 * Reads a token back, or refuses it.
 *
 * `expectedGameId` is required rather than optional. A token is only ever
 * verified in the context of a game the caller has already loaded and checked
 * permissions against, and making the caller pass it means a token minted for
 * one game cannot be spent on another by omission.
 */
export async function verifyCheckinToken(
  token: string,
  expectedGameId: string,
  now: Date = new Date(),
): Promise<CheckinClaim> {
  const parts = token.trim().split(".");
  if (parts.length !== 4) {
    throw new CheckinError("That is not a check-in code.");
  }

  const [gameId, userId, windowText, mac] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (gameId !== expectedGameId) {
    throw new CheckinError("That code is for a different game.");
  }

  const window = Number(windowText);
  if (!Number.isInteger(window)) {
    throw new CheckinError("That is not a check-in code.");
  }

  const current = windowAt(now);
  // The previous bucket is accepted so a code read as the clock rolls over
  // still works. A future bucket is not: it would mean a clock ahead of the
  // server's, and accepting it would extend the token's life rather than
  // preserve it.
  if (window !== current && window !== current - 1) {
    throw new CheckinError("That code has expired. Ask for a fresh one.");
  }

  const expected = await sign(gameId, userId, window);
  if (!timingSafeEqual(mac, expected)) {
    throw new CheckinError("That code could not be verified.");
  }

  return { gameId, userId };
}
