/**
 * Attendance and match results.
 *
 * The rule these all circle is that a number in someone's record only moves
 * when both sides agree it should. Stats are what people argue about, so a
 * self-reported win must not count until the side that lost says so.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  confirmMatch,
  getStats,
  listMatchesForGame,
  rejectMatch,
  reportMatch,
  setAttendance,
} from "./matches.ts";
import { joinGame, SignupError } from "./signups.ts";
import { seedGame, seedPlayers } from "../testing/fixtures.ts";
import { withTestKv } from "../testing/kv_test_helper.ts";

/** A game with four confirmed players, ready to record a doubles match. */
async function gameOfFour(kv: Deno.Kv) {
  const { game, groupId } = await seedGame(kv, {
    courts: 1,
    playersPerCourt: 4,
  });
  const players = await seedPlayers(kv, 4);
  for (const player of players) await joinGame(kv, game.id, player);
  return { game, groupId, players };
}

Deno.test("marking a player present records it once", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);

    const signup = await setAttendance(kv, game.id, players[0]!.id, true, {
      groupId,
    });
    assertEquals(typeof signup.attendedAt, "string");
    assertEquals((await getStats(kv, groupId, players[0]!.id)).attended, 1);
  });
});

Deno.test("marking present twice does not inflate the tally", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);

    await setAttendance(kv, game.id, players[0]!.id, true, { groupId });
    await setAttendance(kv, game.id, players[0]!.id, true, { groupId });

    assertEquals((await getStats(kv, groupId, players[0]!.id)).attended, 1);
  });
});

Deno.test("a no-show is tracked apart from an absence of any mark", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);

    await setAttendance(kv, game.id, players[0]!.id, false, { groupId });

    const stats = await getStats(kv, groupId, players[0]!.id);
    assertEquals(stats.noShow, 1);
    assertEquals(stats.attended, 0);
    // A player never marked at all has neither.
    const untouched = await getStats(kv, groupId, players[1]!.id);
    assertEquals(untouched.noShow, 0);
    assertEquals(untouched.attended, 0);
  });
});

Deno.test("correcting a mark moves the tally rather than adding to both", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);

    // Marked present by mistake, then corrected to absent.
    await setAttendance(kv, game.id, players[0]!.id, true, { groupId });
    await setAttendance(kv, game.id, players[0]!.id, false, { groupId });

    const stats = await getStats(kv, groupId, players[0]!.id);
    assertEquals(stats.attended, 0);
    assertEquals(stats.noShow, 1);
  });
});

Deno.test("a reported result starts pending and counts toward nothing", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 21,
      scoreB: 15,
      reportedBy: a!.id,
    });

    assertEquals(match.status, "pending");
    // Nobody's record moved on a claim alone.
    assertEquals((await getStats(kv, groupId, a!.id)).wins, 0);
    assertEquals((await getStats(kv, groupId, c!.id)).losses, 0);
  });
});

Deno.test("the losing side confirming moves everyone's record", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 21,
      scoreB: 15,
      reportedBy: a!.id,
    });

    await confirmMatch(kv, match.id, c!.id);

    assertEquals((await getStats(kv, groupId, a!.id)).wins, 1);
    assertEquals((await getStats(kv, groupId, b!.id)).wins, 1);
    assertEquals((await getStats(kv, groupId, c!.id)).losses, 1);
    assertEquals((await getStats(kv, groupId, d!.id)).losses, 1);
    assertEquals((await getStats(kv, groupId, a!.id)).gamesPlayed, 1);
  });
});

Deno.test("a winner cannot confirm their own victory", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 21,
      scoreB: 15,
      reportedBy: a!.id,
    });

    await assertRejects(
      () => confirmMatch(kv, match.id, a!.id),
      SignupError,
    );
    assertEquals((await getStats(kv, groupId, a!.id)).wins, 0);
  });
});

Deno.test("confirming twice counts the win once", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 21,
      scoreB: 15,
      reportedBy: a!.id,
    });

    await confirmMatch(kv, match.id, c!.id);
    await confirmMatch(kv, match.id, c!.id);

    assertEquals((await getStats(kv, groupId, a!.id)).wins, 1);
    assertEquals((await getStats(kv, groupId, a!.id)).gamesPlayed, 1);
  });
});

Deno.test("a disputed result never reaches the stats", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 21,
      scoreB: 15,
      reportedBy: a!.id,
    });

    const rejected = await rejectMatch(kv, match.id, c!.id);
    assertEquals(rejected.status, "rejected");
    assertEquals((await getStats(kv, groupId, a!.id)).wins, 0);

    // And it cannot then be confirmed into the stats through the back door.
    await assertRejects(() => confirmMatch(kv, match.id, c!.id), SignupError);
    assertEquals((await getStats(kv, groupId, a!.id)).wins, 0);
  });
});

Deno.test("a confirmed result cannot later be disputed", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 21,
      scoreB: 15,
      reportedBy: a!.id,
    });

    await confirmMatch(kv, match.id, c!.id);
    await assertRejects(() => rejectMatch(kv, match.id, d!.id), SignupError);
  });
});

Deno.test("a match needs four different players", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c] = players;

    await assertRejects(
      () =>
        reportMatch(kv, {
          gameId: game.id,
          groupId,
          sideA: [a!.id, b!.id],
          // `a` cannot play against themselves.
          sideB: [c!.id, a!.id],
          scoreA: 21,
          scoreB: 15,
          reportedBy: a!.id,
        }),
      SignupError,
    );
  });
});

Deno.test("a match cannot end level", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    await assertRejects(
      () =>
        reportMatch(kv, {
          gameId: game.id,
          groupId,
          sideA: [a!.id, b!.id],
          sideB: [c!.id, d!.id],
          scoreA: 21,
          scoreB: 21,
          reportedBy: a!.id,
        }),
      SignupError,
    );
  });
});

Deno.test("only someone who played may report the result", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;
    const [outsider] = await seedPlayers(kv, 1);

    await assertRejects(
      () =>
        reportMatch(kv, {
          gameId: game.id,
          groupId,
          sideA: [a!.id, b!.id],
          sideB: [c!.id, d!.id],
          scoreA: 21,
          scoreB: 15,
          reportedBy: outsider!.id,
        }),
      SignupError,
    );
  });
});

Deno.test("the side with the higher score wins regardless of which it is", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    // Side B wins this time.
    const match = await reportMatch(kv, {
      gameId: game.id,
      groupId,
      sideA: [a!.id, b!.id],
      sideB: [c!.id, d!.id],
      scoreA: 12,
      scoreB: 21,
      reportedBy: c!.id,
    });

    // The losing side is A, so A confirms.
    await confirmMatch(kv, match.id, a!.id);

    assertEquals((await getStats(kv, groupId, c!.id)).wins, 1);
    assertEquals((await getStats(kv, groupId, a!.id)).losses, 1);
  });
});

Deno.test("a game lists every result reported against it", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId, players } = await gameOfFour(kv);
    const [a, b, c, d] = players;

    for (const scoreB of [15, 17]) {
      await reportMatch(kv, {
        gameId: game.id,
        groupId,
        sideA: [a!.id, b!.id],
        sideB: [c!.id, d!.id],
        scoreA: 21,
        scoreB,
        reportedBy: a!.id,
      });
    }

    assertEquals((await listMatchesForGame(kv, game.id)).length, 2);
  });
});
