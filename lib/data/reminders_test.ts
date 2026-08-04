/**
 * Reminders and refunds.
 *
 * The reminder cases are all really one case: the queue delivers at least
 * once, so the same message will arrive twice, and a player must not be
 * emailed twice. The refund cases guard the opposite mistake — recording money
 * as returned when it never arrived in the first place.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  confirmPaid,
  freezeRoster,
  getSignup,
  joinGame,
  leaveGame,
  refundAllForGame,
  refundPayment,
  settlementFor,
  SignupError,
} from "./signups.ts";
import { sendReminder } from "./reminders.ts";
import { seedGame, seedPlayers } from "../testing/fixtures.ts";
import { withTestKv } from "../testing/kv_test_helper.ts";
import { keys } from "../kv/keys.ts";
import type { Game } from "../types.ts";

const HOUR_MS = 60 * 60 * 1000;

/** A start time whose cutoff has already passed, so a freeze is due now. */
function pastCutoffStart(): string {
  return new Date(Date.now() + 1 * HOUR_MS).toISOString();
}

/** Seeds a frozen game with `count` confirmed players. */
async function frozenGame(kv: Deno.Kv, count = 2) {
  const { game, organizer } = await seedGame(kv, {
    courts: 1,
    maxPlayers: 4,
    pricePerPlayerFils: 3000,
    startUtc: pastCutoffStart(),
  });
  const players = await seedPlayers(kv, count);
  for (const player of players) await joinGame(kv, game.id, player);
  await freezeRoster(kv, game.id);
  return { game, organizer, players };
}

Deno.test("a reminder reaches every confirmed player once", async () => {
  await withTestKv(async (kv) => {
    const { game } = await frozenGame(kv, 3);

    const first = await sendReminder(kv, game.id, "t24");
    assertEquals(first.sent, 3);
    assertEquals(first.skipped, 0);
  });
});

Deno.test("a repeated delivery reminds nobody a second time", async () => {
  await withTestKv(async (kv) => {
    const { game } = await frozenGame(kv, 3);

    await sendReminder(kv, game.id, "t24");
    const second = await sendReminder(kv, game.id, "t24");

    assertEquals(second.sent, 0);
    assertEquals(second.skipped, 3);
  });
});

Deno.test("concurrent deliveries of one reminder still send it once", async () => {
  await withTestKv(async (kv) => {
    const { game } = await frozenGame(kv, 4);

    // The same message arriving four times at once, as at-least-once delivery
    // permits. Exactly four emails must go out in total, not sixteen.
    const outcomes = await Promise.all([
      sendReminder(kv, game.id, "pay"),
      sendReminder(kv, game.id, "pay"),
      sendReminder(kv, game.id, "pay"),
      sendReminder(kv, game.id, "pay"),
    ]);

    const totalSent = outcomes.reduce((sum, o) => sum + o.sent, 0);
    assertEquals(totalSent, 4);
  });
});

Deno.test("different reminder tags are tracked separately", async () => {
  await withTestKv(async (kv) => {
    const { game, players } = await frozenGame(kv, 2);

    await sendReminder(kv, game.id, "pay");
    const t24 = await sendReminder(kv, game.id, "t24");

    assertEquals(t24.sent, 2);
    const signup = await getSignup(kv, game.id, players[0]!.id);
    assertEquals(signup?.remindersSent.sort(), ["pay", "t24"]);
  });
});

Deno.test("a player who left is not reminded", async () => {
  await withTestKv(async (kv) => {
    const { game, players } = await frozenGame(kv, 3);
    await leaveGame(kv, game.id, players[0]!.id);

    const outcome = await sendReminder(kv, game.id, "t24");
    assertEquals(outcome.sent, 2);
  });
});

Deno.test("a cancelled game reminds nobody", async () => {
  await withTestKv(async (kv) => {
    const { game } = await frozenGame(kv, 2);

    const entry = await kv.get<Game>(keys.game(game.id));
    await kv.set(
      keys.game(game.id),
      {
        ...entry.value!,
        status: "cancelled",
      } satisfies Game,
    );

    const outcome = await sendReminder(kv, game.id, "t24");
    assertEquals(outcome.sent, 0);
  });
});

Deno.test("a game that already started reminds nobody", async () => {
  await withTestKv(async (kv) => {
    const { game } = await frozenGame(kv, 2);

    const entry = await kv.get<Game>(keys.game(game.id));
    await kv.set(
      keys.game(game.id),
      {
        ...entry.value!,
        startUtc: new Date(Date.now() - HOUR_MS).toISOString(),
      } satisfies Game,
    );

    const outcome = await sendReminder(kv, game.id, "t3");
    assertEquals(outcome.sent, 0);
  });
});

Deno.test("only a confirmed payment can be refunded", async () => {
  await withTestKv(async (kv) => {
    const { game, players } = await frozenGame(kv, 1);

    // Never paid, so there is nothing to send back.
    await assertRejects(
      () => refundPayment(kv, game.id, players[0]!.id),
      SignupError,
    );
  });
});

Deno.test("refunding a paid signup records it as refunded", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer, players } = await frozenGame(kv, 1);
    await confirmPaid(kv, game.id, players[0]!.id, organizer.id);

    const refunded = await refundPayment(kv, game.id, players[0]!.id);
    assertEquals(refunded.payment, "refunded");
  });
});

Deno.test("refunding twice is a no-op rather than an error", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer, players } = await frozenGame(kv, 1);
    await confirmPaid(kv, game.id, players[0]!.id, organizer.id);

    await refundPayment(kv, game.id, players[0]!.id);
    const second = await refundPayment(kv, game.id, players[0]!.id);
    assertEquals(second.payment, "refunded");
  });
});

Deno.test("a refund leaves the money neither owed nor collected", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer, players } = await frozenGame(kv, 2);
    await confirmPaid(kv, game.id, players[0]!.id, organizer.id);
    await confirmPaid(kv, game.id, players[1]!.id, organizer.id);

    const before = await settlementFor(kv, game.id);
    assertEquals(before.collectedFils, 6000);
    assertEquals(before.outstandingFils, 0);

    await refundPayment(kv, game.id, players[0]!.id);
    const after = await settlementFor(kv, game.id);

    // The refunded share drops out of both sides, not just one.
    assertEquals(after.owedFils, 3000);
    assertEquals(after.collectedFils, 3000);
    assertEquals(after.outstandingFils, 0);
    assertEquals(after.refundedFils, 3000);
    assertEquals(after.refundedCount, 1);
  });
});

Deno.test("a bulk refund returns only the money that actually arrived", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer, players } = await frozenGame(kv, 3);
    // Two paid, one never did.
    await confirmPaid(kv, game.id, players[0]!.id, organizer.id);
    await confirmPaid(kv, game.id, players[1]!.id, organizer.id);

    const result = await refundAllForGame(kv, game.id);

    assertEquals(result.refunded.length, 2);
    assertEquals(result.totalFils, 6000);
    // The unpaid player is left alone — there is nothing to send back.
    const unpaid = await getSignup(kv, game.id, players[2]!.id);
    assertEquals(unpaid?.payment, "unpaid");
  });
});
