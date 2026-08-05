/**
 * Asking the organizer to be let into one game, and their answer.
 *
 * A password game states its terms plainly — anyone can see it, only the code
 * takes a seat — but until now the only way to get that code was to already
 * know someone. A player who finds the game has no way to ask, which makes the
 * lock a dead end rather than a door.
 *
 * Deliberately separate from `JoinRequest` in `groups.ts`, which it otherwise
 * resembles. A club membership is a standing relationship; this is about one
 * evening, and being let into Tuesday's game is not joining anything.
 *
 * Approval records the unlock rather than mailing the code. The code then never
 * travels through an inbox it could be forwarded from, and the organizer keeps
 * the ability to change it without every past approval leaking the new one. The
 * player still chooses to take a seat afterwards — approval opens the door, it
 * does not walk them through it.
 */

import { keys } from "../kv/keys.ts";
import { getRecord, listRecords, withRetry } from "../kv/kv.ts";
import { nowIso } from "../domain/time.ts";
import { recordUnlock } from "../domain/game_access.ts";
import type { AccessRequest, Game } from "../types.ts";

/** A refusal the player can act on, as opposed to a bug. */
export class AccessRequestError extends Error {}

/**
 * Records a player asking to be let in.
 *
 * Asking twice is not an error and does not queue twice — the pending request
 * they already have comes back unchanged. A player whose request was refused
 * may ask again, which overwrites the refusal: an organizer who said no last
 * week may say yes this week, and the alternative is a permanent ban nobody
 * chose to impose.
 */
export async function requestAccess(
  kv: Deno.Kv,
  game: Pick<Game, "id" | "visibility">,
  userId: string,
  message?: string,
): Promise<AccessRequest> {
  if (game.visibility === "public") {
    throw new AccessRequestError("This game is open — just join it.");
  }

  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<AccessRequest>(
      kv,
      keys.accessRequest(game.id, userId),
    );

    // Already asked and still waiting: hand back what they have rather than
    // resetting its timestamp and pushing them down the organizer's list.
    if (entry.value?.status === "pending") {
      return { op: kv.atomic().check(entry), result: entry.value };
    }
    if (entry.value?.status === "approved") {
      throw new AccessRequestError("You are already in — take a seat.");
    }

    const request: AccessRequest = {
      v: 1,
      gameId: game.id,
      userId,
      status: "pending",
      message,
      requestedAt: nowIso(),
    };

    return {
      op: kv.atomic().check(entry).set(
        keys.accessRequest(game.id, userId),
        request,
      ),
      result: request,
    };
  });

  if (!result) throw new AccessRequestError("That request did not go through.");
  return result;
}

/**
 * The organizer letting someone in.
 *
 * The decision and the unlock are two writes rather than one commit. If the
 * second fails the request reads as approved while the join button stays shut,
 * which is the safe direction to fail in — the player is told to try again
 * rather than being let somewhere the organizer did not agree to. Re-approving
 * is refused by then, so recovery is the organizer sharing the code directly.
 * Worth folding into one atomic operation if it ever bites.
 *
 * Approving does not take a seat. The player may find the game full by the
 * time they act, and being waitlisted after that is the correct outcome: the
 * organizer opened the door, they did not promise a place on the court.
 */
export async function approveAccess(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  decidedBy: string,
): Promise<AccessRequest> {
  const decided = await decide(kv, gameId, userId, "approved", decidedBy);
  await recordUnlock(kv, gameId, userId);
  return decided;
}

/** The organizer turning someone down. */
export async function rejectAccess(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  decidedBy: string,
): Promise<AccessRequest> {
  return await decide(kv, gameId, userId, "rejected", decidedBy);
}

async function decide(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  status: "approved" | "rejected",
  decidedBy: string,
): Promise<AccessRequest> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<AccessRequest>(
      kv,
      keys.accessRequest(gameId, userId),
    );
    const request = entry.value;
    if (!request) {
      throw new AccessRequestError("That request no longer exists.");
    }
    if (request.status !== "pending") {
      // Two organizers deciding at once, or a double-tapped button. The first
      // answer stands rather than being quietly overwritten by the second.
      throw new AccessRequestError("That request has already been decided.");
    }

    const next: AccessRequest = {
      ...request,
      status,
      decidedAt: nowIso(),
      decidedBy,
    };

    return {
      op: kv.atomic().check(entry).set(
        keys.accessRequest(gameId, userId),
        next,
      ),
      result: next,
    };
  });

  if (!result) {
    throw new AccessRequestError("That decision did not go through.");
  }
  return result;
}

export async function getAccessRequest(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<AccessRequest | null> {
  const entry = await getRecord<AccessRequest>(
    kv,
    keys.accessRequest(gameId, userId),
  );
  return entry.value;
}

/** Every request ever made of a game, decided or not. */
export async function listAccessRequests(
  kv: Deno.Kv,
  gameId: string,
  limit = 200,
): Promise<AccessRequest[]> {
  const rows = await listRecords<AccessRequest>(
    kv,
    { prefix: keys.accessRequestsByGamePrefix(gameId) },
    { limit },
  );
  return rows.map((row) => row.value);
}
