/**
 * Builders for the records tests need.
 *
 * These exist so a test that cares about one field does not have to spell out
 * the other twenty, and so that adding a required field to `Game` breaks one
 * file rather than every test at once.
 */

import type { Game, GameVisibility, GroupRole, User } from "../types.ts";
import { createUser } from "../data/users.ts";
import { createGame } from "../data/games.ts";
import { ensureDefaultGroup, ensureMembership } from "../data/groups.ts";

const HOUR_MS = 60 * 60 * 1000;

/** A start time far enough out that the cutoff has not passed. */
export function futureStart(hoursAhead = 96): string {
  return new Date(Date.now() + hoursAhead * HOUR_MS).toISOString();
}

export interface TestGameOptions {
  courts?: number;
  playersPerCourt?: number;
  pricePerPlayerFils?: number;
  maxGuestsPerPlayer?: number;
  cutoffHours?: number;
  startUtc?: string;
  status?: Game["status"];
  visibility?: GameVisibility;
}

/** Seeds a group and a game with sane defaults; capacity is courts × players. */
export async function seedGame(
  kv: Deno.Kv,
  options: TestGameOptions = {},
): Promise<{ game: Game; organizer: User; groupId: string }> {
  const organizer = await createUser(kv, {
    email: `organizer-${crypto.randomUUID()}@example.com`,
    name: "Organizer",
    role: "organizer",
  });

  const group = await ensureDefaultGroup(kv, organizer.id);
  // Owning a group is not the same as being in it: the owner needs a
  // membership row too, or they appear in no club list of their own.
  await ensureMembership(kv, group.id, organizer.id, "organizer");
  const startUtc = options.startUtc ?? futureStart();

  const game = await createGame(kv, {
    groupId: group.id,
    title: "Test Session",
    venue: { name: "Test Courts", address: "Dubai" },
    startUtc,
    endUtc: new Date(new Date(startUtc).getTime() + 2 * HOUR_MS).toISOString(),
    courts: options.courts ?? 1,
    playersPerCourt: options.playersPerCourt ?? 4,
    pricePerPlayerFils: options.pricePerPlayerFils ?? 3000,
    maxGuestsPerPlayer: options.maxGuestsPerPlayer ?? 1,
    cutoffHours: options.cutoffHours ?? 48,
    createdBy: organizer.id,
    status: options.status,
    visibility: options.visibility,
  });

  return { game, organizer, groupId: group.id };
}

/**
 * Joins a user to a group.
 *
 * Nothing joins anyone automatically any more, so a test whose player needs to
 * act on a game has to say so — the same explicit act the invite flow performs
 * in production.
 */
export async function seedMember(
  kv: Deno.Kv,
  groupId: string,
  user: User,
  role: GroupRole = "player",
): Promise<void> {
  await ensureMembership(kv, groupId, user.id, role);
}

/** Creates `count` players, each with a unique email. */
export async function seedPlayers(
  kv: Deno.Kv,
  count: number,
): Promise<User[]> {
  const players: User[] = [];
  for (let i = 0; i < count; i++) {
    players.push(await seedPlayer(kv, i));
  }
  return players;
}

/**
 * One player. Returns `User` rather than `User | undefined`, so tests that
 * need a single player do not have to defeat the strict index check on
 * `seedPlayers(kv, 1)[0]`.
 */
export async function seedPlayer(kv: Deno.Kv, index = 0): Promise<User> {
  return await createUser(kv, {
    email: `player-${index}-${crypto.randomUUID()}@example.com`,
    name: `Player ${index}`,
  });
}
