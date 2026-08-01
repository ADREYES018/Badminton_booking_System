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
  GuestPricing,
  Skill,
  Venue,
} from "../types.ts";
import { DEFAULT_MAX_GUESTS_PER_PLAYER } from "../types.ts";
import { nowIso } from "../domain/time.ts";
import { randomToken } from "../crypto.ts";
import { slugify } from "../domain/validate.ts";

/** Public listings only carry games anyone may find. */
function isListedPublicly(game: Pick<Game, "visibility" | "status">): boolean {
  return game.visibility === "public" && game.status !== "draft" &&
    game.status !== "cancelled";
}

export async function getGame(
  kv: Deno.Kv,
  gameId: string,
): Promise<Game | null> {
  const entry = await getRecord<Game>(kv, keys.game(gameId));
  return entry.value;
}

export async function getGameBySlug(
  kv: Deno.Kv,
  slug: string,
): Promise<Game | null> {
  const pointer = await kv.get<string>(keys.gameBySlug(slug));
  if (!pointer.value) return null;
  return await getGame(kv, pointer.value);
}

export interface CreateGameInput {
  groupId: string;
  title: string;
  venue: Venue;
  startUtc: string;
  endUtc: string;
  courts: number;
  playersPerCourt: number;
  totalCostFils: number;
  guestPricing: GuestPricing;
  cutoffHours: number;
  createdBy: string;
  courtMode?: CourtMode;
  maxGuestsPerPlayer?: number;
  skillMin?: Skill;
  skillMax?: Skill;
  visibility?: GameVisibility;
  joinPasswordHash?: string;
  status?: GameStatus;
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
    v: 1,
    id: ulid(),
    groupId: input.groupId,
    slug: gameSlug(input.title, visibility),
    title: input.title,
    venue: input.venue,
    startUtc: input.startUtc,
    endUtc: input.endUtc,

    courts: input.courts,
    courtMode: input.courtMode ?? "fixed",
    playersPerCourt: input.playersPerCourt,
    courtStatus: "not_reserved",

    totalCostFils: input.totalCostFils,
    guestPricing: input.guestPricing,
    maxGuestsPerPlayer: input.maxGuestsPerPlayer ??
      DEFAULT_MAX_GUESTS_PER_PLAYER,

    skillMin: input.skillMin,
    skillMax: input.skillMax,

    visibility,
    joinPasswordHash: input.joinPasswordHash,

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
    .set(keys.gameBySlug(game.slug), game.id)
    .set(keys.gamesByGroup(game.groupId, game.startUtc, game.id), game.id);

  if (isListedPublicly(game)) {
    op = op.set(keys.gamesOpen(game.startUtc, game.id), game.id);
  }

  const result = await op.commit();
  if (!result.ok) {
    throw new ConflictError("Could not create that game, please try again");
  }

  return game;
}

export interface UpdateGameInput {
  title?: string;
  venue?: Venue;
  startUtc?: string;
  endUtc?: string;
  courts?: number;
  playersPerCourt?: number;
  totalCostFils?: number;
  guestPricing?: GuestPricing;
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
    if (update.venue !== undefined) next.venue = update.venue;
    if (update.startUtc !== undefined) next.startUtc = update.startUtc;
    if (update.endUtc !== undefined) next.endUtc = update.endUtc;
    if (update.courts !== undefined) next.courts = update.courts;
    if (update.playersPerCourt !== undefined) {
      next.playersPerCourt = update.playersPerCourt;
    }
    if (update.totalCostFils !== undefined) {
      next.totalCostFils = update.totalCostFils;
    }
    if (update.guestPricing !== undefined) {
      next.guestPricing = update.guestPricing;
    }
    if (update.maxGuestsPerPlayer !== undefined) {
      next.maxGuestsPerPlayer = update.maxGuestsPerPlayer;
    }
    if (update.cutoffHours !== undefined) next.cutoffHours = update.cutoffHours;
    if (update.courtStatus !== undefined) next.courtStatus = update.courtStatus;
    if (update.visibility !== undefined) next.visibility = update.visibility;
    if (update.status !== undefined) next.status = update.status;
    if (update.skillMin !== undefined) {
      next.skillMin = update.skillMin ?? undefined;
    }
    if (update.skillMax !== undefined) {
      next.skillMax = update.skillMax ?? undefined;
    }

    let op = kv.atomic().check(entry).set(keys.game(gameId), next);

    // The group listing is keyed by start time.
    if (next.startUtc !== current.startUtc) {
      op = op
        .delete(keys.gamesByGroup(current.groupId, current.startUtc, gameId))
        .set(keys.gamesByGroup(next.groupId, next.startUtc, gameId), gameId);
    }

    // The public listing is keyed by start time *and* conditional on the game
    // still being publicly listable, so both inputs are re-evaluated together.
    const wasListed = isListedPublicly(current);
    const isListed = isListedPublicly(next);

    if (wasListed && (!isListed || next.startUtc !== current.startUtc)) {
      op = op.delete(keys.gamesOpen(current.startUtc, gameId));
    }
    if (isListed && (!wasListed || next.startUtc !== current.startUtc)) {
      op = op.set(keys.gamesOpen(next.startUtc, gameId), gameId);
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
      op = op.delete(keys.gamesOpen(current.startUtc, gameId));
    }

    return { op, result: next };
  });

  if (!result) throw new ConflictError("Cancellation did not apply");
  return result;
}

/**
 * Upcoming public games, soonest first.
 *
 * The index is keyed by start time, so "upcoming" is a range read from now
 * rather than a scan-and-filter.
 */
export async function listOpenGames(
  kv: Deno.Kv,
  options: { limit?: number; from?: Date } = {},
): Promise<Game[]> {
  const from = (options.from ?? new Date()).toISOString();
  const pointers = await listRecords<string>(kv, {
    start: keys.gamesOpen(from, ""),
    end: keys.gamesOpen("9999", ""),
  }, { limit: options.limit ?? 50 });

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
 * fail someone's page load.
 */
async function hydrate(kv: Deno.Kv, gameIds: string[]): Promise<Game[]> {
  if (gameIds.length === 0) return [];
  const entries = await Promise.all(gameIds.map((id) => getGame(kv, id)));
  return entries.filter((game): game is Game => game !== null);
}
