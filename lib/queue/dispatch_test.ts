/**
 * The queue handler and the read-triggered sweep that backs it up.
 *
 * Messages are handed to `handleQueueMessage` directly rather than through
 * `kv.enqueue`, so these tests assert on behaviour rather than on delivery
 * timing. At-least-once delivery is simulated by calling the handler twice.
 */

import { assert, assertEquals } from "@std/assert";
import { withTestKv } from "../testing/kv_test_helper.ts";
import { futureStart, seedGame, seedPlayers } from "../testing/fixtures.ts";
import { handleQueueMessage } from "./dispatch.ts";
import { isQueueMessage } from "./messages.ts";
import { getGame } from "../data/games.ts";
import {
  getSignup,
  joinGame,
  leaveGame,
  promoteNext,
} from "../data/signups.ts";
import { needsFreeze, sweepGame } from "../data/sweep.ts";
import type { Game } from "../types.ts";

Deno.test("well-formed messages are recognised", () => {
  assertEquals(isQueueMessage({ kind: "promote", gameId: "g1" }), true);
  assertEquals(isQueueMessage({ kind: "cutoff_freeze", gameId: "g1" }), true);
  assertEquals(
    isQueueMessage({
      kind: "promotion_expiry",
      gameId: "g1",
      userId: "u1",
      confirmDeadline: "2026-01-01T00:00:00.000Z",
    }),
    true,
  );
});

Deno.test("malformed messages are rejected rather than dispatched", () => {
  assertEquals(isQueueMessage(null), false);
  assertEquals(isQueueMessage("promote"), false);
  assertEquals(isQueueMessage({ kind: "drop_database" }), false);
  assertEquals(isQueueMessage({ kind: "promote" }), false);
  assertEquals(isQueueMessage({ gameId: "g1" }), false);
});

Deno.test("an unrecognised message is dropped without throwing", async () => {
  await withTestKv(async (kv) => {
    // A malformed message must not take the listener down.
    await handleQueueMessage(kv, { kind: "nonsense" });
  });
});

Deno.test("a promote message fills a freed seat", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id);

    await handleQueueMessage(kv, { kind: "promote", gameId: game.id });

    const promoted = await getSignup(kv, game.id, players[1]!.id);
    assertEquals(promoted?.status, "pending_confirm");
  });
});

Deno.test("a repeated promote message does not promote twice", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 3);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await joinGame(kv, game.id, players[2]!);
    await leaveGame(kv, game.id, players[0]!.id);

    // At-least-once delivery: the same message arrives three times.
    await handleQueueMessage(kv, { kind: "promote", gameId: game.id });
    await handleQueueMessage(kv, { kind: "promote", gameId: game.id });
    await handleQueueMessage(kv, { kind: "promote", gameId: game.id });

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 1);
    assertEquals(after.waitlistCount, 1);
  });
});

Deno.test("a cutoff_freeze message settles what each player owes", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
      pricePerPlayerFils: 8000,
    });
    const players = await seedPlayers(kv, 2);
    for (const player of players) await joinGame(kv, game.id, player);

    await handleQueueMessage(kv, { kind: "cutoff_freeze", gameId: game.id });

    const after = await getGame(kv, game.id) as Game;
    assert(after.rosterFrozenAt);
    for (const player of players) {
      const signup = await getSignup(kv, game.id, player.id);
      assertEquals(signup?.owedFils, 8000);
    }
  });
});

Deno.test("a repeated freeze message leaves the locked figure alone", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
      pricePerPlayerFils: 8000,
    });
    const players = await seedPlayers(kv, 2);
    for (const player of players) await joinGame(kv, game.id, player);

    await handleQueueMessage(kv, { kind: "cutoff_freeze", gameId: game.id });
    const first = await getGame(kv, game.id) as Game;

    // Someone else joins after the freeze, then the message is redelivered.
    await handleQueueMessage(kv, { kind: "cutoff_freeze", gameId: game.id });

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.rosterFrozenAt, first.rosterFrozenAt);
  });
});

Deno.test("a message for a deleted game is ignored", async () => {
  await withTestKv(async (kv) => {
    await handleQueueMessage(kv, { kind: "promote", gameId: "does-not-exist" });
    await handleQueueMessage(kv, {
      kind: "cutoff_freeze",
      gameId: "does-not-exist",
    });
  });
});

// --- The read-triggered sweep ----------------------------------------------

Deno.test("needsFreeze spots an overdue roster and nothing else", async () => {
  await withTestKv(async (kv) => {
    const overdue = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
    });
    assertEquals(needsFreeze(overdue.game), true);

    const early = await seedGame(kv, {
      startUtc: futureStart(200),
      cutoffHours: 48,
    });
    assertEquals(needsFreeze(early.game), false);
  });
});

Deno.test("a frozen roster is never frozen again by the sweep", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
    });
    const players = await seedPlayers(kv, 2);
    for (const player of players) await joinGame(kv, game.id, player);

    await sweepGame(kv, game);
    const first = await getGame(kv, game.id) as Game;
    assert(first.rosterFrozenAt);

    await sweepGame(kv, first);
    const second = await getGame(kv, game.id) as Game;
    assertEquals(second.rosterFrozenAt, first.rosterFrozenAt);
  });
});

Deno.test("the sweep releases a held seat whose deadline has passed", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 3);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await joinGame(kv, game.id, players[2]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    // The promoted player never answered and their window has closed.
    const held = await getSignup(kv, game.id, players[1]!.id);
    await kv.set(["signup", game.id, players[1]!.id], {
      ...held,
      confirmDeadline: new Date(Date.now() - 1000).toISOString(),
    });

    const stale = await getGame(kv, game.id) as Game;
    await sweepGame(kv, stale);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 0);
    // The seat is free again for whoever is next.
    assertEquals(after.waitlistCount, 1);
  });
});

Deno.test("the sweep leaves a live confirm window alone", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    const current = await getGame(kv, game.id) as Game;
    await sweepGame(kv, current);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 1);
  });
});

Deno.test("sweeping a cancelled game does nothing", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
    });
    const cancelled: Game = { ...game, status: "cancelled" };
    await sweepGame(kv, cancelled);
    assertEquals(
      (await getGame(kv, game.id) as Game).rosterFrozenAt,
      undefined,
    );
  });
});
