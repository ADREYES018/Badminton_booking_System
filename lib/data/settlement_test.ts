/**
 * Settlement: what each player owes, and how that gets marked and confirmed.
 *
 * The rule under test throughout is that a bill, once settled, does not move.
 * It is settled by whichever comes first — the player paying, the organizer
 * confirming, or the cutoff freezing the roster — and nothing afterwards may
 * rewrite it. The alternative silently changes what someone owes after they
 * may already have transferred the money.
 */

import { assert, assertEquals } from "@std/assert";
import {
  confirmPaid,
  freezeRoster,
  joinGame,
  leaveGame,
  markPaid,
  settlementFor,
} from "./signups.ts";
import { getGame, updateGame } from "./games.ts";
import { getSignup } from "./signups.ts";
import { seedGame, seedPlayers } from "../testing/fixtures.ts";
import { withTestKv } from "../testing/kv_test_helper.ts";
import type { Game } from "../types.ts";
import { keys } from "../kv/keys.ts";

const HOUR_MS = 60 * 60 * 1000;

/** A start time whose cutoff has already passed, so a freeze is due now. */
function pastCutoffStart(): string {
  return new Date(Date.now() + 1 * HOUR_MS).toISOString();
}

/**
 * Moves a game's cutoff into the past so a freeze is due.
 *
 * Guests may only be added before the cutoff, while `freezeRoster` only fires
 * after it, so a test needing both cannot use one fixed start time. Players
 * and guests join against a future cutoff, then this pulls the start time back
 * to make the freeze due — the same thing an organizer rescheduling a game
 * does, and the reason `freezeRoster` re-reads rather than trusting its
 * message.
 */
async function makeCutoffDue(kv: Deno.Kv, gameId: string): Promise<void> {
  const entry = await kv.get<Game>(keys.game(gameId));
  const game = entry.value!;
  // The game starts in an hour with a two-hour cutoff, putting the cutoff an
  // hour in the past while the game itself has not started.
  await kv.set(
    keys.game(gameId),
    {
      ...game,
      startUtc: new Date(Date.now() + HOUR_MS).toISOString(),
      cutoffHours: 2,
    } satisfies Game,
  );
}

Deno.test("freezing writes each player their own share", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      cutoffHours: 48,
      startUtc: pastCutoffStart(),
    });
    const players = await seedPlayers(kv, 4);
    for (const player of players) await joinGame(kv, game.id, player);

    assertEquals((await freezeRoster(kv, game.id)).frozen, true);

    for (const player of players) {
      const signup = await getSignup(kv, game.id, player.id);
      assertEquals(signup?.owedFils, 3000);
    }
    assert((await getGame(kv, game.id))?.rosterFrozenAt);
  });
});

Deno.test("a player who brought a guest owes both shares", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      maxGuestsPerPlayer: 1,
    });
    const [host, other] = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, host!, {
      guests: [{ id: "g1", name: "Guest" }],
    });
    await joinGame(kv, game.id, other!);

    await makeCutoffDue(kv, game.id);
    await freezeRoster(kv, game.id);

    // A guest costs what a player costs, and it lands on whoever brought them.
    const hostSignup = await getSignup(kv, game.id, host!.id);
    const otherSignup = await getSignup(kv, game.id, other!.id);
    assertEquals(hostSignup?.owedFils, 6000);
    assertEquals(otherSignup?.owedFils, 3000);
  });
});

Deno.test("a bill written at the cutoff does not move afterwards", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const players = await seedPlayers(kv, 4);
    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);

    await freezeRoster(kv, game.id);
    assertEquals(
      (await getSignup(kv, game.id, players[0]!.id))?.owedFils,
      3000,
    );

    // A third joins after the freeze. The original two must not be re-billed.
    await joinGame(kv, game.id, players[2]!);

    assertEquals(
      (await getSignup(kv, game.id, players[0]!.id))?.owedFils,
      3000,
    );
    assertEquals(
      (await getSignup(kv, game.id, players[1]!.id))?.owedFils,
      3000,
    );
    // The late joiner was never frozen, so carries no bill from this freeze.
    assertEquals(
      (await getSignup(kv, game.id, players[2]!.id))?.owedFils,
      undefined,
    );
  });
});

Deno.test("held seats are not billed", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 2,
      pricePerPlayerFils: 2500,
      startUtc: pastCutoffStart(),
    });
    const [a, b, c] = await seedPlayers(kv, 3);

    await joinGame(kv, game.id, a!);
    await joinGame(kv, game.id, b!);
    // c is waitlisted; a leaves, so c is offered the seat but has not accepted.
    await joinGame(kv, game.id, c!);
    await leaveGame(kv, game.id, a!.id);

    await freezeRoster(kv, game.id);

    // Only the one confirmed player carries a bill.
    assertEquals(
      (await getSignup(kv, game.id, b!.id))?.owedFils !== undefined,
      true,
    );
    const cancelled = await getSignup(kv, game.id, a!.id);
    assertEquals(cancelled?.owedFils, undefined);
  });
});

Deno.test("freezing twice does not rewrite what players owe", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const players = await seedPlayers(kv, 2);
    for (const player of players) await joinGame(kv, game.id, player);

    await freezeRoster(kv, game.id);
    const second = await freezeRoster(kv, game.id);

    assertEquals(second.frozen, false);
    assertEquals(
      (await getSignup(kv, game.id, players[0]!.id))?.owedFils,
      3000,
    );
  });
});

Deno.test("an unpaid player counts as owing before the freeze", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
    });
    const players = await seedPlayers(kv, 2);
    for (const player of players) await joinGame(kv, game.id, player);

    // Nothing has frozen and nobody has paid, but two seats are held.
    const settlement = await settlementFor(kv, game.id);
    assertEquals(settlement.owedFils, 6000);
    assertEquals(settlement.outstandingFils, 6000);
    assertEquals(settlement.unpaidCount, 2);
  });
});

Deno.test("a player can pay before the roster closes", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
    });
    const [player] = await seedPlayers(kv, 1);
    await joinGame(kv, game.id, player!);

    // Players pay up front, and the price is fixed, so there is a real figure
    // to pay against long before the cutoff.
    const marked = await markPaid(kv, game.id, player!.id);
    assertEquals(marked.payment, "marked_paid");
    assertEquals(marked.owedFils, 3000);
  });
});

Deno.test("a bill settled by paying early survives a later price rise", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
    });
    const [player] = await seedPlayers(kv, 1);
    await joinGame(kv, game.id, player!);
    await markPaid(kv, game.id, player!.id);

    await updateGame(kv, game.id, { pricePerPlayerFils: 9000 });
    await freezeRoster(kv, game.id);

    // They transferred 30 against a stated price of 30. The freeze must not
    // turn that into a shortfall.
    assertEquals(
      (await getSignup(kv, game.id, player!.id))?.owedFils,
      3000,
    );
  });
});

Deno.test("marking then confirming walks the payment states in order", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const [player] = await seedPlayers(kv, 1);
    await joinGame(kv, game.id, player!);
    await freezeRoster(kv, game.id);

    const marked = await markPaid(kv, game.id, player!.id);
    assertEquals(marked.payment, "marked_paid");
    assertEquals(typeof marked.paidMarkedAt, "string");

    const confirmed = await confirmPaid(
      kv,
      game.id,
      player!.id,
      organizer.id,
    );
    assertEquals(confirmed.payment, "paid");
    assertEquals(confirmed.paidConfirmedBy, organizer.id);
  });
});

Deno.test("the organizer may confirm a payment the player never marked", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const [player] = await seedPlayers(kv, 1);
    await joinGame(kv, game.id, player!);
    await freezeRoster(kv, game.id);

    const confirmed = await confirmPaid(kv, game.id, player!.id, organizer.id);
    assertEquals(confirmed.payment, "paid");
  });
});

Deno.test("a late claim cannot undo the organizer's confirmation", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const [player] = await seedPlayers(kv, 1);
    await joinGame(kv, game.id, player!);
    await freezeRoster(kv, game.id);

    await confirmPaid(kv, game.id, player!.id, organizer.id);
    const afterClaim = await markPaid(kv, game.id, player!.id);

    // Still paid — the player's claim must not walk the state backwards.
    assertEquals(afterClaim.payment, "paid");
  });
});

Deno.test("confirming twice is a no-op rather than an error", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const [player] = await seedPlayers(kv, 1);
    await joinGame(kv, game.id, player!);
    await freezeRoster(kv, game.id);

    const first = await confirmPaid(kv, game.id, player!.id, organizer.id);
    const second = await confirmPaid(kv, game.id, player!.id, organizer.id);

    assertEquals(second.payment, "paid");
    // The original confirmation timestamp is not overwritten.
    assertEquals(second.paidConfirmedAt, first.paidConfirmedAt);
  });
});

Deno.test("settlement counts a claim as outstanding, not collected", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      startUtc: pastCutoffStart(),
    });
    const players = await seedPlayers(kv, 4);
    for (const player of players) await joinGame(kv, game.id, player);
    await freezeRoster(kv, game.id);

    // One confirmed, one merely claimed, two untouched.
    await confirmPaid(kv, game.id, players[0]!.id, organizer.id);
    await markPaid(kv, game.id, players[1]!.id);

    const settlement = await settlementFor(kv, game.id);

    assertEquals(settlement.owedFils, 12000);
    assertEquals(settlement.collectedFils, 3000);
    assertEquals(settlement.outstandingFils, 9000);
    assertEquals(settlement.paidCount, 1);
    assertEquals(settlement.markedCount, 1);
    assertEquals(settlement.unpaidCount, 2);
  });
});
