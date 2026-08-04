/**
 * Attendance and match results.
 *
 * Two ideas that look similar and are not:
 *
 *   *attendance* is a fact about a game — did this player turn up
 *   *a match* is a result within it — who beat whom
 *
 * They are recorded separately because they fail separately. A player can
 * attend and play no recorded match, and a match can be reported by someone
 * whose attendance was never marked. Conflating them would make "played 12
 * games" mean two different things depending on which path wrote the record.
 *
 * ## Why a result needs confirming
 *
 * Anyone on the roster may report a score, which means anyone can report a
 * wrong one — including in their own favour. A reported match starts
 * `pending` and only counts toward the leaderboard once someone on the losing
 * side confirms it. Until then it is a claim, exactly as `marked_paid` is a
 * claim about money. Stats are the thing people argue about, so the rule is
 * that a number only moves when both sides agree it should.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import {
  ConflictError,
  getRecord,
  listRecords,
  mutateRecord,
  withRetry,
} from "../kv/kv.ts";
import type { Match, PlayerStats, Signup } from "../types.ts";
import { nowIso } from "../domain/time.ts";
import { SignupError } from "./signups.ts";

/**
 * Marks whether a confirmed player actually turned up.
 *
 * `attendedAt` on the signup is the record of fact; the group-level counters
 * are a running total derived from it. They are updated only when the flag
 * actually changes, so an organizer tapping the same toggle twice does not
 * inflate anyone's attendance.
 */
export async function setAttendance(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  attended: boolean,
  // `null` is accepted alongside absent so a clubless game's `groupId` passes
  // straight through: both mean there are no per-club counters to move.
  options: { groupId?: string | null } = {},
): Promise<Signup> {
  // Captured from the read that the winning attempt committed against.
  // `wasMarked` says whether this replaces an earlier mark; `changed` says
  // whether anything moved at all. A no-op previously still ran a bump that
  // happened to cancel itself out — skipping it outright is the same result
  // without the write.
  let wasMarked = false;
  let changed = false;

  const signup = await mutateRecord<Signup>(
    kv,
    keys.signup(gameId, userId),
    async (kv) => {
      const entry = await getRecord<Signup>(kv, keys.signup(gameId, userId));
      const signup = entry.value;
      if (!signup) throw new SignupError("That player is not on this roster.");
      if (signup.status !== "confirmed") {
        throw new SignupError("Only confirmed players can be marked present.");
      }

      // Three states, not two: present, absent, and not yet marked. Comparing
      // against `attendedAt` alone would make "mark absent" a no-op for a
      // player nobody had marked yet — the commonest case there is.
      const current = signup.attendedAt !== undefined
        ? true
        : signup.markedAbsentAt !== undefined
        ? false
        : null;
      if (current === attended) return null;
      wasMarked = current !== null;
      changed = true;

      const now = nowIso();
      return {
        op: kv.atomic().check(entry).set(
          keys.signup(gameId, userId),
          {
            ...signup,
            attendedAt: attended ? now : undefined,
            markedAbsentAt: attended ? undefined : now,
            updatedAt: now,
          } satisfies Signup,
        ),
        result: true,
      };
    },
  );

  // Only on a real change, and only when the caller knows the group — the
  // counters are per-group and there is nothing sensible to write without it.
  if (changed && options.groupId) {
    await bumpAttendance(kv, options.groupId, userId, attended, wasMarked);
  }

  return signup;
}

/**
 * Moves one player's attended/no-show tallies by a single game.
 *
 * `wasMarked` says whether this replaces an earlier mark. An organizer
 * correcting a mistake — marking someone absent who they had marked present —
 * must move the count from one column to the other, not add to both.
 */
async function bumpAttendance(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
  attended: boolean,
  wasMarked: boolean,
): Promise<void> {
  await withRetry(kv, async (kv) => {
    const entry = await getRecord<PlayerStats>(
      kv,
      keys.stats(groupId, userId),
    );
    const stats = entry.value ?? emptyStats(groupId, userId);

    // A correction takes one off the opposite tally; a first mark does not.
    const undo = wasMarked ? 1 : 0;

    return {
      op: kv.atomic().check(entry).set(
        keys.stats(groupId, userId),
        {
          ...stats,
          attended: Math.max(
            0,
            stats.attended + (attended ? 1 : -undo),
          ),
          noShow: Math.max(0, stats.noShow + (attended ? -undo : 1)),
          updatedAt: nowIso(),
        } satisfies PlayerStats,
      ),
      result: true,
    };
  });
}

export interface ReportMatchInput {
  gameId: string;
  /** `null` for a clubless game; the result counts toward no leaderboard. */
  groupId: string | null;
  sideA: [string, string];
  sideB: [string, string];
  scoreA: number;
  scoreB: number;
  reportedBy: string;
}

/**
 * Reports a doubles result.
 *
 * Validation is deliberately about the shape of the claim rather than the
 * plausibility of the score — badminton scores vary by format, and an
 * organizer correcting a genuine oddity is worse served by a rule that
 * refuses it. A draw is rejected because there is no such thing.
 */
export async function reportMatch(
  kv: Deno.Kv,
  input: ReportMatchInput,
): Promise<Match> {
  const players = [...input.sideA, ...input.sideB];
  if (new Set(players).size !== 4) {
    throw new SignupError("A doubles match needs four different players.");
  }
  if (input.scoreA === input.scoreB) {
    throw new SignupError("A match cannot end level.");
  }
  if (input.scoreA < 0 || input.scoreB < 0) {
    throw new SignupError("Scores cannot be negative.");
  }
  if (!players.includes(input.reportedBy)) {
    throw new SignupError("Only someone who played can report the result.");
  }

  const match: Match = {
    v: 1,
    id: ulid(),
    gameId: input.gameId,
    groupId: input.groupId,
    sideA: input.sideA,
    sideB: input.sideB,
    scoreA: input.scoreA,
    scoreB: input.scoreB,
    status: "pending",
    reportedBy: input.reportedBy,
    createdAt: nowIso(),
  };

  let op = kv.atomic()
    .set(keys.match(match.id), match)
    .set(keys.matchesByGame(match.gameId, match.id), match.id);

  for (const userId of players) {
    op = op.set(
      keys.matchesByUser(userId, match.createdAt, match.id),
      match.id,
    );
  }

  const commit = await op.commit();
  if (!commit.ok) throw new ConflictError("That result did not save.");
  return match;
}

/** Which side won, as user ids. */
function winners(match: Match): readonly string[] {
  return match.scoreA > match.scoreB ? match.sideA : match.sideB;
}

function losers(match: Match): readonly string[] {
  return match.scoreA > match.scoreB ? match.sideB : match.sideA;
}

/**
 * Confirms a reported result, moving it into everyone's stats.
 *
 * Only a player on the losing side may confirm. The winner reporting and then
 * confirming their own victory would make the pending state decorative, and
 * the losing side is the one with a reason to object.
 */
export async function confirmMatch(
  kv: Deno.Kv,
  matchId: string,
  confirmedBy: string,
): Promise<Match> {
  // Whether this call is the one that confirmed, as opposed to finding it
  // already confirmed — stats may only move once.
  let confirmedHere = false;

  const updated = await mutateRecord<Match>(
    kv,
    keys.match(matchId),
    async (kv) => {
      const entry = await getRecord<Match>(kv, keys.match(matchId));
      const match = entry.value;
      if (!match) throw new SignupError("That result no longer exists.");
      if (match.status === "confirmed") return null;
      if (match.status === "rejected") {
        throw new SignupError("That result was already disputed.");
      }
      if (!losers(match).includes(confirmedBy)) {
        throw new SignupError(
          "Only a player on the losing side can confirm a result.",
        );
      }
      confirmedHere = true;

      return {
        op: kv.atomic().check(entry).set(
          keys.match(matchId),
          {
            ...match,
            status: "confirmed",
            resolvedBy: confirmedBy,
            resolvedAt: nowIso(),
          } satisfies Match,
        ),
        result: true,
      };
    },
  );

  // Stats move only on the commit that actually confirmed, so a duplicate
  // call cannot count one win twice.
  if (confirmedHere) await applyMatchToStats(kv, updated);

  return updated;
}

/** Disputes a reported result. A rejected match never reaches the stats. */
export async function rejectMatch(
  kv: Deno.Kv,
  matchId: string,
  rejectedBy: string,
): Promise<Match> {
  return await mutateRecord<Match>(kv, keys.match(matchId), async (kv) => {
    const entry = await getRecord<Match>(kv, keys.match(matchId));
    const match = entry.value;
    if (!match) throw new SignupError("That result no longer exists.");
    if (match.status === "rejected") return null;
    if (match.status === "confirmed") {
      throw new SignupError("That result was already confirmed.");
    }
    if (![...match.sideA, ...match.sideB].includes(rejectedBy)) {
      throw new SignupError("Only someone who played can dispute a result.");
    }

    return {
      op: kv.atomic().check(entry).set(
        keys.match(matchId),
        {
          ...match,
          status: "rejected",
          resolvedBy: rejectedBy,
          resolvedAt: nowIso(),
        } satisfies Match,
      ),
      result: true,
    };
  });
}

function emptyStats(groupId: string, userId: string): PlayerStats {
  return {
    v: 1,
    groupId,
    userId,
    attended: 0,
    noShow: 0,
    wins: 0,
    losses: 0,
    gamesPlayed: 0,
    updatedAt: nowIso(),
  };
}

/**
 * Applies one confirmed match to the four players' records.
 *
 * A clubless game has no leaderboard for a result to move — `stats` is keyed
 * by club, and there is no club here. The match is still stored, still shown
 * on the game, and still confirmed by the losing side; it simply ranks nobody.
 * Inventing a scope to hold these would merge strangers' one-off games into a
 * single global table nobody asked to be on.
 */
async function applyMatchToStats(kv: Deno.Kv, match: Match): Promise<void> {
  const groupId = match.groupId;
  if (groupId === null) return;

  const won = new Set(winners(match));

  for (const userId of [...match.sideA, ...match.sideB]) {
    await withRetry(kv, async (kv) => {
      const entry = await getRecord<PlayerStats>(
        kv,
        keys.stats(groupId, userId),
      );
      const stats = entry.value ?? emptyStats(groupId, userId);
      const next: PlayerStats = {
        ...stats,
        wins: stats.wins + (won.has(userId) ? 1 : 0),
        losses: stats.losses + (won.has(userId) ? 0 : 1),
        gamesPlayed: stats.gamesPlayed + 1,
        updatedAt: nowIso(),
      };

      return {
        op: kv.atomic()
          .check(entry)
          .set(keys.stats(groupId, userId), next),
        result: true,
      };
    });
  }
}

export async function getStats(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
): Promise<PlayerStats> {
  const entry = await getRecord<PlayerStats>(kv, keys.stats(groupId, userId));
  return entry.value ?? emptyStats(groupId, userId);
}

/**
 * Every player's record in one group, unsorted.
 *
 * Ordering and the qualifying threshold stay with the caller. They are
 * presentation rules — a different screen may want a different order — and a
 * data function that silently drops rows is one that is hard to trust.
 */
export async function listStats(
  kv: Deno.Kv,
  groupId: string,
  limit = 500,
): Promise<PlayerStats[]> {
  const entries = await listRecords<PlayerStats>(
    kv,
    { prefix: keys.statsByGroupPrefix(groupId) },
    { limit },
  );
  return entries.map((entry) => entry.value);
}

/** Every match reported for a game, newest first. */
export async function listMatchesForGame(
  kv: Deno.Kv,
  gameId: string,
): Promise<Match[]> {
  const pointers = await listRecords<string>(kv, {
    prefix: keys.matchesByGamePrefix(gameId),
  });

  const matches = await Promise.all(
    pointers.map(async (p) =>
      (await getRecord<Match>(kv, keys.match(p.value)))
        .value
    ),
  );
  return matches.filter((m): m is Match => m !== null);
}
