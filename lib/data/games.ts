/**
 * Game records and their secondary indexes.
 *
 * A game is written to up to three places in one commit:
 *   game/<id>                        the record
 *   game_by_slug/<slug>              lookup by the URL the player sees
 *   games_by_group/<gid>/<start>/... the organizer's chronological list
 *   games_open/<start>/<id>          the public listing, public games only
 *
 * Keeping the index writes here — rather than in the routes — is what makes it
 * impossible to create a game that is invisible to one listing and present in
 * another. Every mutation that changes `startUtc`, `visibility` or `status`
 * moves the affected pointers in the same atomic operation as the record.
 *
 * Seat counts are deliberately NOT touched here. They belong to `signups.ts`,
 * which owns every write that can affect capacity; splitting that ownership is
 * how oversell bugs get in.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import { ConflictError, getRecord, listRecords, withRetry } from "../kv/kv.ts";
import type {
  CourtMode,
  Game,
  GameStatus,
  GameVisibility,
  Skill,
  Sport,
  Venue,
} from "../types.ts";
import { DEFAULT_MAX_GUESTS_PER_PLAYER, DEFAULT_SPORT } from "../types.ts";
import { nowIso } from "../domain/time.ts";
import { randomToken } from "../crypto.ts";
import { slugify } from "../domain/validate.ts";

/**
 * Whether a game belongs in the listings anyone can browse.
 *
 * A password game is listed. Its code gates the roster and the seat, not the
 * knowledge that the game exists — an organizer shares the code with people
 * who already know about the game, and hiding it as well would leave them
 * nothing to apply the code to. Only `unlisted` is truly hidden, where the URL
 * itself is the access control.
 */
function isListedPublicly(
  game: Pick<Game, "visibility" | "status" | "deletedAt">,
): boolean {
  return game.deletedAt === undefined && game.visibility !== "unlisted" &&
    game.status !== "draft" && game.status !== "cancelled";
}

/**
 * Reads a game.
 *
 * A deleted game reads as absent. Every caller in the app wants that — a
 * deleted game must not be joinable, listable or linkable — and making the
 * common path the safe one means a new caller cannot forget the check. The
 * few places that genuinely need the record back (the delete itself, and any
 * future restore) pass `includeDeleted`.
 */
export async function getGame(
  kv: Deno.Kv,
  gameId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<Game | null> {
  const entry = await getRecord<Game>(kv, keys.game(gameId));
  const game = entry.value;
  if (!game) return null;
  if (game.deletedAt !== undefined && !options.includeDeleted) return null;
  return game;
}

export async function getGameBySlug(
  kv: Deno.Kv,
  slug: string,
  options: { includeDeleted?: boolean } = {},
): Promise<Game | null> {
  const pointer = await kv.get<string>(keys.gameBySlug(slug));
  if (!pointer.value) return null;
  return await getGame(kv, pointer.value, options);
}

export interface CreateGameInput {
  /** `null` posts a game that belongs to no club; see `Game.groupId`. */
  groupId: string | null;
  title: string;
  sport?: Sport;
  venue: Venue;
  startUtc: string;
  endUtc: string;
  courts: number;
  /** Total seats. Independent of the court count; see `Game.maxPlayers`. */
  maxPlayers: number;
  pricePerPlayerFils: number;
  cutoffHours: number;
  createdBy: string;
  courtMode?: CourtMode;
  maxGuestsPerPlayer?: number;
  skillMin?: Skill;
  skillMax?: Skill;
  visibility?: GameVisibility;
  status?: GameStatus;
}

/**
 * The six digits that unlock a password game.
 *
 * Leading zeros are kept — a code shown as "004821" has to be typed back as
 * six characters, and dropping to a five-digit number would make some codes
 * look malformed next to others.
 */
export function generateJoinCode(): string {
  const digits = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return digits.toString().padStart(6, "0");
}

/**
 * Builds a slug that is readable for public games and unguessable otherwise.
 *
 * An unlisted game's URL is its only access control, so the random suffix is
 * long enough to be worth nothing to a guesser. Public games get a short
 * suffix purely to avoid collisions between two "Sunday Doubles".
 */
function gameSlug(title: string, visibility: GameVisibility): string {
  const base = slugify(title).slice(0, 40) || "game";
  const suffix = visibility === "public" ? randomToken(3) : randomToken(12);
  return `${base}-${suffix}`;
}

export async function createGame(
  kv: Deno.Kv,
  input: CreateGameInput,
): Promise<Game> {
  const now = nowIso();
  const visibility = input.visibility ?? "public";

  const game: Game = {
    v: 3,
    id: ulid(),
    groupId: input.groupId,
    slug: gameSlug(input.title, visibility),
    title: input.title,
    sport: input.sport ?? DEFAULT_SPORT,
    venue: input.venue,
    startUtc: input.startUtc,
    endUtc: input.endUtc,

    courts: input.courts,
    courtMode: input.courtMode ?? "fixed",
    maxPlayers: input.maxPlayers,
    courtStatus: "not_reserved",

    pricePerPlayerFils: input.pricePerPlayerFils,
    maxGuestsPerPlayer: input.maxGuestsPerPlayer ??
      DEFAULT_MAX_GUESTS_PER_PLAYER,

    skillMin: input.skillMin,
    skillMax: input.skillMax,

    visibility,
    joinCode: visibility === "password" ? generateJoinCode() : undefined,

    cutoffHours: input.cutoffHours,
    status: input.status ?? "open",

    confirmedCount: 0,
    pendingCount: 0,
    waitlistCount: 0,
    guestCount: 0,

    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  let op = kv.atomic()
    .check({ key: keys.gameBySlug(game.slug), versionstamp: null })
    .set(keys.game(game.id), game)
    .set(keys.gameBySlug(game.slug), game.id);

  // "The games I am running" is a club index for a club's game and a creator
  // index for a clubless one. Exactly one of the two is written, so the game
  // appears once in whichever listing is the right home for it.
  op = game.groupId === null
    ? op.set(
      keys.gamesByCreator(game.createdBy, game.startUtc, game.id),
      game.id,
    )
    : op.set(keys.gamesByGroup(game.groupId, game.startUtc, game.id), game.id);

  if (isListedPublicly(game)) {
    // The per-club listing needs a club; the global one never did.
    if (game.groupId !== null) {
      op = op.set(
        keys.gamesOpen(game.groupId, game.startUtc, game.id),
        game.id,
      );
    }
    op = op.set(keys.gamesAll(game.startUtc, game.id), game.id);
  }

  const result = await op.commit();
  if (!result.ok) {
    throw new ConflictError("Could not create that game, please try again");
  }

  return game;
}

export interface UpdateGameInput {
  title?: string;
  sport?: Sport;
  venue?: Venue;
  startUtc?: string;
  endUtc?: string;
  courts?: number;
  maxPlayers?: number;
  pricePerPlayerFils?: number;
  maxGuestsPerPlayer?: number;
  cutoffHours?: number;
  courtStatus?: Game["courtStatus"];
  skillMin?: Skill | null;
  skillMax?: Skill | null;
  visibility?: GameVisibility;
  status?: GameStatus;
}

/** True when a change moves the cutoff, so the freeze job must be re-scheduled. */
export function affectsCutoff(update: UpdateGameInput): boolean {
  return update.startUtc !== undefined || update.cutoffHours !== undefined;
}

/**
 * Updates a game, moving whichever index pointers the change invalidates.
 *
 * `startUtc` appears inside two index keys, so a time change is a delete plus
 * a set on each — done in the same commit as the record write, so a listing
 * can never point at a game that has moved.
 *
 * Capacity may be reduced below the number of seats already taken; that is the
 * organizer's call and is not rejected here. It leaves the game over-subscribed
 * rather than silently ejecting players, which is a decision a human should
 * make.
 */
export async function updateGame(
  kv: Deno.Kv,
  gameId: string,
  update: UpdateGameInput,
): Promise<Game> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Game>(kv, keys.game(gameId));
    const current = entry.value;
    if (!current) throw new Error(`Game ${gameId} not found`);

    const next: Game = { ...current, updatedAt: nowIso() };

    if (update.title !== undefined) next.title = update.title;
    if (update.sport !== undefined) next.sport = update.sport;
    if (update.venue !== undefined) next.venue = update.venue;
    if (update.startUtc !== undefined) next.startUtc = update.startUtc;
    if (update.endUtc !== undefined) next.endUtc = update.endUtc;
    if (update.courts !== undefined) next.courts = update.courts;
    if (update.maxPlayers !== undefined) {
      next.maxPlayers = update.maxPlayers;
    }
    if (update.pricePerPlayerFils !== undefined) {
      next.pricePerPlayerFils = update.pricePerPlayerFils;
    }
    if (update.maxGuestsPerPlayer !== undefined) {
      next.maxGuestsPerPlayer = update.maxGuestsPerPlayer;
    }
    if (update.cutoffHours !== undefined) next.cutoffHours = update.cutoffHours;
    if (update.courtStatus !== undefined) next.courtStatus = update.courtStatus;
    // A game that becomes password-protected needs a code; one that stops
    // being password-protected must not keep a stale code lying around for a
    // later switch back to silently re-admit everyone who was ever told it.
    if (update.visibility !== undefined) {
      next.visibility = update.visibility;
      if (next.visibility === "password") {
        next.joinCode = current.joinCode ?? generateJoinCode();
      } else {
        next.joinCode = undefined;
      }
    }
    if (update.status !== undefined) next.status = update.status;
    if (update.skillMin !== undefined) {
      next.skillMin = update.skillMin ?? undefined;
    }
    if (update.skillMax !== undefined) {
      next.skillMax = update.skillMax ?? undefined;
    }

    let op = kv.atomic().check(entry).set(keys.game(gameId), next);

    // The organizer's listing is keyed by start time, so moving the game moves
    // the pointer. Which index holds it depends on whether it has a club, and
    // a game never changes clubs, so both sides use the same branch.
    if (next.startUtc !== current.startUtc) {
      op = current.groupId === null
        ? op
          .delete(
            keys.gamesByCreator(current.createdBy, current.startUtc, gameId),
          )
          .set(
            keys.gamesByCreator(next.createdBy, next.startUtc, gameId),
            gameId,
          )
        : op
          .delete(keys.gamesByGroup(current.groupId, current.startUtc, gameId))
          .set(
            keys.gamesByGroup(current.groupId, next.startUtc, gameId),
            gameId,
          );
    }

    // The public listing is keyed by start time *and* conditional on the game
    // still being publicly listable, so both inputs are re-evaluated together.
    const wasListed = isListedPublicly(current);
    const isListed = isListedPublicly(next);

    // A game never moves between groups, so the group segment of the key is
    // the same on both sides and only `startUtc` can move the pointer. A
    // clubless game has no per-club pointer to move; it lives in `gamesAll`
    // alone.
    if (wasListed && (!isListed || next.startUtc !== current.startUtc)) {
      if (current.groupId !== null) {
        op = op.delete(
          keys.gamesOpen(current.groupId, current.startUtc, gameId),
        );
      }
      op = op.delete(keys.gamesAll(current.startUtc, gameId));
    }
    if (isListed && (!wasListed || next.startUtc !== current.startUtc)) {
      if (next.groupId !== null) {
        op = op.set(
          keys.gamesOpen(next.groupId, next.startUtc, gameId),
          gameId,
        );
      }
      op = op.set(keys.gamesAll(next.startUtc, gameId), gameId);
    }

    return { op, result: next };
  });

  if (!result) throw new ConflictError("Game update did not apply");
  return result;
}

/**
 * Cancels a game and removes it from the public listing.
 *
 * Signups are left in place: who was on the roster when it was called off is
 * exactly what the organizer needs for refunds.
 */
export async function cancelGame(
  kv: Deno.Kv,
  gameId: string,
  reason: string,
): Promise<Game> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Game>(kv, keys.game(gameId));
    const current = entry.value;
    if (!current) throw new Error(`Game ${gameId} not found`);

    const next: Game = {
      ...current,
      status: "cancelled",
      cancelledReason: reason,
      updatedAt: nowIso(),
    };

    let op = kv.atomic().check(entry).set(keys.game(gameId), next);
    if (isListedPublicly(current)) {
      if (current.groupId !== null) {
        op = op.delete(
          keys.gamesOpen(current.groupId, current.startUtc, gameId),
        );
      }
      op = op.delete(keys.gamesAll(current.startUtc, gameId));
    }

    return { op, result: next };
  });

  if (!result) throw new ConflictError("Cancellation did not apply");
  return result;
}

/**
 * Deletes a game, keeping every record behind it.
 *
 * The game leaves all four indexes, so it is gone from the listings, from its
 * club's page and from its organizer's own view. The record itself stays, and
 * so do the signups, matches, payments and audit entries — someone who paid
 * into this game must keep the proof that they did, and the organizer settling
 * up still needs to see who owes what.
 *
 * `getGame` hides it from then on, which is what makes the removal complete
 * without anything being destroyed: the slug pointer is deliberately left in
 * place so the URL resolves to a 404 rather than being free for a later game
 * to reuse and inherit this one's inbound links.
 */
export async function deleteGame(
  kv: Deno.Kv,
  gameId: string,
  deletedBy: string,
): Promise<Game> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Game>(kv, keys.game(gameId));
    const current = entry.value;
    if (!current) throw new Error(`Game ${gameId} not found`);

    const next: Game = {
      ...current,
      deletedAt: nowIso(),
      deletedBy,
      updatedAt: nowIso(),
    };

    let op = kv.atomic().check(entry).set(keys.game(gameId), next);

    if (isListedPublicly(current)) {
      if (current.groupId !== null) {
        op = op.delete(
          keys.gamesOpen(current.groupId, current.startUtc, gameId),
        );
      }
      op = op.delete(keys.gamesAll(current.startUtc, gameId));
    }

    op = current.groupId === null
      ? op.delete(
        keys.gamesByCreator(current.createdBy, current.startUtc, gameId),
      )
      : op.delete(
        keys.gamesByGroup(current.groupId, current.startUtc, gameId),
      );

    return { op, result: next };
  });

  if (!result) throw new ConflictError("Deletion did not apply");
  return result;
}

/**
 * Upcoming public games in one group, soonest first.
 *
 * The index is keyed by group then start time, so "upcoming here" is a range
 * read from now rather than a scan-and-filter.
 */
export async function listOpenGames(
  kv: Deno.Kv,
  groupId: string,
  options: { limit?: number; from?: Date } = {},
): Promise<Game[]> {
  const from = (options.from ?? new Date()).toISOString();
  const pointers = await listRecords<string>(kv, {
    start: keys.gamesOpen(groupId, from, ""),
    end: keys.gamesOpen(groupId, "9999", ""),
  }, { limit: options.limit ?? 50 });

  return await hydrate(kv, pointers.map((p) => p.value));
}

/**
 * Upcoming listed games everywhere, soonest first.
 *
 * What the app opens on. Games are browsed across clubs rather than within
 * one, so a player who has joined nothing still lands on something to join.
 */
export async function listAllOpenGames(
  kv: Deno.Kv,
  options: { limit?: number; from?: Date } = {},
): Promise<Game[]> {
  const from = (options.from ?? new Date()).toISOString();
  const pointers = await listRecords<string>(kv, {
    start: keys.gamesAll(from, ""),
    end: keys.gamesAll("9999", ""),
  }, { limit: options.limit ?? 100 });

  return await hydrate(kv, pointers.map((p) => p.value));
}

/**
 * Every clubless game one player has posted, including cancellations.
 *
 * The counterpart to `listGamesByGroup` for someone organizing outside any
 * club. Their club games are not here — those belong to the club's listing,
 * which is where an organizer expects to find them.
 */
export async function listGamesByCreator(
  kv: Deno.Kv,
  userId: string,
  options: { limit?: number; from?: Date; reverse?: boolean } = {},
): Promise<Game[]> {
  const from = (options.from ?? new Date(0)).toISOString();
  const pointers = await listRecords<string>(kv, {
    start: keys.gamesByCreator(userId, from, ""),
    end: keys.gamesByCreator(userId, "9999", ""),
  }, { limit: options.limit ?? 100, reverse: options.reverse });

  return await hydrate(kv, pointers.map((p) => p.value));
}

/** Every game in a group, including drafts and cancellations. */
export async function listGamesByGroup(
  kv: Deno.Kv,
  groupId: string,
  options: { limit?: number; from?: Date; reverse?: boolean } = {},
): Promise<Game[]> {
  const from = (options.from ?? new Date(0)).toISOString();
  const pointers = await listRecords<string>(kv, {
    start: keys.gamesByGroup(groupId, from, ""),
    end: keys.gamesByGroup(groupId, "9999", ""),
  }, { limit: options.limit ?? 100, reverse: options.reverse });

  return await hydrate(kv, pointers.map((p) => p.value));
}

/**
 * Turns index pointers into records.
 *
 * A pointer whose game has vanished is skipped rather than throwing — an index
 * entry outliving its record is a repairable inconsistency, not a reason to
 * fail someone's page load. A deleted game reads as absent through `getGame`,
 * so it is dropped by the same filter and cannot surface through a pointer
 * that a failed commit left behind.
 */
async function hydrate(kv: Deno.Kv, gameIds: string[]): Promise<Game[]> {
  if (gameIds.length === 0) return [];
  const entries = await Promise.all(gameIds.map((id) => getGame(kv, id)));
  return entries.filter((game): game is Game => game !== null);
}
