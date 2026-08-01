/**
 * Signup behaviour, including the concurrency suite.
 *
 * The races below are the reason `withRetry` and the atomic `.check(gameEntry)`
 * pattern exist. Each one drives the real code paths against a real KV
 * database with genuinely parallel promises — no mocking of the commit, since
 * the commit is precisely what is under test.
 *
 * Every concurrency case asserts on the *invariant*, not on which particular
 * caller won. Who gets the last seat is a race and may legitimately differ
 * between runs; how many seats exist afterwards is not negotiable.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { withTestKv } from "../testing/kv_test_helper.ts";
import {
  futureStart,
  seedGame,
  seedPlayer,
  seedPlayers,
} from "../testing/fixtures.ts";
import { getGame } from "./games.ts";
import {
  addGuest,
  confirmPromotion,
  expirePromotion,
  freezeRoster,
  getSignup,
  joinGame,
  leaveGame,
  loadRoster,
  promoteNext,
  removeGuest,
  SignupError,
} from "./signups.ts";
import { capacityOf, seatsRemaining, seatsTaken } from "../domain/money.ts";
import type { Game } from "../types.ts";

/** The invariant every test asserts: counters agree with reality, no oversell. */
async function assertSeatsConsistent(kv: Deno.Kv, gameId: string) {
  const game = await getGame(kv, gameId) as Game;
  const roster = await loadRoster(kv, gameId);

  assertEquals(
    game.confirmedCount,
    roster.confirmed.length,
    "confirmedCount must match the confirmed roster",
  );
  assertEquals(
    game.pendingCount,
    roster.pending.length,
    "pendingCount must match the held-seat roster",
  );
  assertEquals(
    game.waitlistCount,
    roster.waitlisted.length,
    "waitlistCount must match the waitlist",
  );

  const guestsHeld = [...roster.confirmed, ...roster.pending]
    .reduce((sum, s) => sum + s.guests.length, 0);
  assertEquals(
    game.guestCount,
    guestsHeld,
    "guestCount must match guests on seat-holding signups",
  );

  assert(
    seatsTaken(game) <= capacityOf(game),
    `oversold: ${seatsTaken(game)} seats taken of ${capacityOf(game)}`,
  );
}

// --- Basic behaviour -------------------------------------------------------

Deno.test("joining an empty game confirms a seat", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    const player = await seedPlayer(kv);

    const result = await joinGame(kv, game.id, player);
    assertEquals(result.outcome, "confirmed");

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.confirmedCount, 1);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("joining a full game lands on the waitlist", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 2 });
    const players = await seedPlayers(kv, 3);

    for (const player of players.slice(0, 2)) {
      assertEquals((await joinGame(kv, game.id, player)).outcome, "confirmed");
    }

    const third = await joinGame(kv, game.id, players[2]!);
    assertEquals(third.outcome, "waitlisted");
    assertEquals(third.signup.waitlistSeq, 1);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.status, "full");
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("joining twice is refused", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    await assertRejects(
      () => joinGame(kv, game.id, player),
      SignupError,
      "already signed up",
    );
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("a cancelled player may re-join and leaves no duplicate roster entry", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    await leaveGame(kv, game.id, player.id);
    await joinGame(kv, game.id, player);

    const roster = await loadRoster(kv, game.id);
    assertEquals(roster.confirmed.length, 1);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("joining a started game is refused", async () => {
  await withTestKv(async (kv) => {
    const started = new Date(Date.now() - 60_000).toISOString();
    const { game } = await seedGame(kv, { startUtc: started, cutoffHours: 0 });
    const player = await seedPlayer(kv);

    await assertRejects(
      () => joinGame(kv, game.id, player),
      SignupError,
      "already started",
    );
  });
});

Deno.test("joining a cancelled game is refused", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { status: "draft" });
    const player = await seedPlayer(kv);
    await assertRejects(() => joinGame(kv, game.id, player), SignupError);
  });
});

Deno.test("leaving before the cutoff does not forfeit payment", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { cutoffHours: 48 });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    const result = await leaveGame(kv, game.id, player.id);
    assertEquals(result.signup.payment, "unpaid");
    assertEquals(result.seatFreed, true);
  });
});

Deno.test("leaving after the cutoff forfeits", async () => {
  await withTestKv(async (kv) => {
    // Starts in 4 hours with a 48-hour cutoff: the cutoff is long past.
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
    });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    const result = await leaveGame(kv, game.id, player.id);
    assertEquals(result.signup.payment, "forfeited");
  });
});

Deno.test("an organizer removing a player never forfeits their payment", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
    });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    const result = await leaveGame(kv, game.id, player.id, {
      byOrganizer: true,
    });
    assertEquals(result.signup.payment, "unpaid");
  });
});

Deno.test("leaving a game you never joined is refused", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    const player = await seedPlayer(kv);
    await assertRejects(
      () => leaveGame(kv, game.id, player.id),
      SignupError,
      "not signed up",
    );
  });
});

// --- Guests ----------------------------------------------------------------

Deno.test("a guest takes a real seat", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 4 });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    await addGuest(kv, game.id, player.id, { name: "Sam" });

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.guestCount, 1);
    assertEquals(seatsRemaining(after), 2);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("a guest cannot be added past the organizer's limit", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { maxGuestsPerPlayer: 1 });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    await addGuest(kv, game.id, player.id, { name: "Sam" });
    await assertRejects(
      () => addGuest(kv, game.id, player.id, { name: "Alex" }),
      SignupError,
    );
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("guests are refused when the organizer disabled them", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { maxGuestsPerPlayer: 0 });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    await assertRejects(
      () => addGuest(kv, game.id, player.id, { name: "Sam" }),
      SignupError,
      "does not allow guests",
    );
  });
});

Deno.test("a guest cannot take the last seat twice over", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 2 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);

    await assertRejects(
      () => addGuest(kv, game.id, players[0]!.id, { name: "Sam" }),
      SignupError,
      "no seat left",
    );
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("a player bringing a guest is waitlisted when only one seat is left", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 2,
      maxGuestsPerPlayer: 1,
    });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    // One seat left, but this party needs two — the pair stays together.
    const result = await joinGame(kv, game.id, players[1]!, {
      guests: [{ id: "g1", name: "Sam" }],
    });

    assertEquals(result.outcome, "waitlisted");
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("removing a guest frees the seat", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 2 });
    const player = await seedPlayer(kv);

    await joinGame(kv, game.id, player);
    const withGuest = await addGuest(kv, game.id, player.id, { name: "Sam" });
    assertEquals((await getGame(kv, game.id) as Game).status, "full");

    await removeGuest(kv, game.id, player.id, withGuest.guests[0]!.id);
    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.guestCount, 0);
    assertEquals(after.status, "open");
    await assertSeatsConsistent(kv, game.id);
  });
});

// --- Waitlist promotion ----------------------------------------------------

Deno.test("a freed seat promotes the head of the waitlist, who must confirm", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 2 });
    const players = await seedPlayers(kv, 3);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await joinGame(kv, game.id, players[2]!);

    await leaveGame(kv, game.id, players[0]!.id);
    const promotion = await promoteNext(kv, game.id);

    assertEquals(promotion.promoted, true);
    assertEquals(promotion.userId, players[2]!.id);
    assertEquals(promotion.autoConfirmed, false);

    const signup = await getSignup(kv, game.id, players[2]!.id);
    assertEquals(signup?.status, "pending_confirm");
    assert(signup?.confirmDeadline);

    // The held seat blocks the court but is not billed.
    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 1);
    assertEquals(after.confirmedCount, 1);
    assertEquals(seatsRemaining(after), 0);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("promotion respects waitlist order", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 4);

    await joinGame(kv, game.id, players[0]!);
    // Sequential joins give a deterministic queue order.
    await joinGame(kv, game.id, players[1]!);
    await joinGame(kv, game.id, players[2]!);
    await joinGame(kv, game.id, players[3]!);

    await leaveGame(kv, game.id, players[0]!.id);
    const first = await promoteNext(kv, game.id);
    assertEquals(first.userId, players[1]!.id);

    await leaveGame(kv, game.id, players[1]!.id);
    const second = await promoteNext(kv, game.id);
    assertEquals(second.userId, players[2]!.id);
  });
});

Deno.test("inside the final hour a promotion is granted outright", async () => {
  await withTestKv(async (kv) => {
    // Starts in 30 minutes: too soon to wait for an answer.
    const startUtc = new Date(Date.now() + 30 * 60_000).toISOString();
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 1,
      startUtc,
      cutoffHours: 48,
    });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id, { byOrganizer: true });

    const promotion = await promoteNext(kv, game.id);
    assertEquals(promotion.autoConfirmed, true);

    const signup = await getSignup(kv, game.id, players[1]!.id);
    assertEquals(signup?.status, "confirmed");

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 0);
    assertEquals(after.confirmedCount, 1);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("confirming a promotion moves the seat into the cost split", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 2 });
    const players = await seedPlayers(kv, 3);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await joinGame(kv, game.id, players[2]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    await confirmPromotion(kv, game.id, players[2]!.id);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 0);
    assertEquals(after.confirmedCount, 2);
    // Capacity is unchanged by confirming — the seat was already held.
    assertEquals(seatsRemaining(after), 0);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("confirming without a pending offer is refused", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    const player = await seedPlayer(kv);
    await joinGame(kv, game.id, player);

    await assertRejects(
      () => confirmPromotion(kv, game.id, player.id),
      SignupError,
      "no seat waiting",
    );
  });
});

Deno.test("an expired promotion releases the seat and passes the offer on", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 3);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await joinGame(kv, game.id, players[2]!);

    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    // Force the deadline into the past, the way the clock would.
    const signup = await getSignup(kv, game.id, players[1]!.id);
    await kv.set(["signup", game.id, players[1]!.id], {
      ...signup,
      confirmDeadline: new Date(Date.now() - 1000).toISOString(),
    });

    const expiry = await expirePromotion(kv, game.id, players[1]!.id);
    assertEquals(expiry.expired, true);
    assertEquals(expiry.effects.length, 1);

    const afterExpiry = await getGame(kv, game.id) as Game;
    assertEquals(afterExpiry.pendingCount, 0);
    assertEquals(seatsRemaining(afterExpiry), 1);

    // The offer cascades to the next person in line.
    const next = await promoteNext(kv, game.id);
    assertEquals(next.userId, players[2]!.id);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("expiry does nothing once the player has confirmed", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);
    await confirmPromotion(kv, game.id, players[1]!.id);

    const expiry = await expirePromotion(kv, game.id, players[1]!.id);
    assertEquals(expiry.expired, false);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.confirmedCount, 1);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("an expiry message that fires early is ignored", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    // The deadline is still in the future; the seat must stay held.
    const expiry = await expirePromotion(kv, game.id, players[1]!.id);
    assertEquals(expiry.expired, false);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.pendingCount, 1);
  });
});

Deno.test("an expiry message carrying a stale deadline is ignored", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    const expiry = await expirePromotion(
      kv,
      game.id,
      players[1]!.id,
      "2020-01-01T00:00:00.000Z",
    );
    assertEquals(expiry.expired, false);
    assertEquals((await getGame(kv, game.id) as Game).pendingCount, 1);
  });
});

Deno.test("promoting with an empty waitlist is a no-op", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    const result = await promoteNext(kv, game.id);
    assertEquals(result.promoted, false);
  });
});

Deno.test("promoting a full game is a no-op", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);

    // No seat was freed, so there is nothing to hand out.
    const result = await promoteNext(kv, game.id);
    assertEquals(result.promoted, false);
    await assertSeatsConsistent(kv, game.id);
  });
});

// --- Cutoff freeze ---------------------------------------------------------

Deno.test("freezing locks the per-head cost", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
      totalCostFils: 12000,
      courts: 1,
      playersPerCourt: 4,
    });
    const players = await seedPlayers(kv, 3);
    for (const player of players) await joinGame(kv, game.id, player);

    const result = await freezeRoster(kv, game.id);
    assertEquals(result.frozen, true);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.frozenPerHeadFils, 4000);
    assert(after.rosterFrozenAt);
  });
});

Deno.test("freezing twice does not move the locked figure", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
      totalCostFils: 12000,
    });
    const players = await seedPlayers(kv, 3);
    for (const player of players) await joinGame(kv, game.id, player);

    await freezeRoster(kv, game.id);
    const first = await getGame(kv, game.id) as Game;

    const second = await freezeRoster(kv, game.id);
    assertEquals(second.frozen, false);

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.frozenPerHeadFils, first.frozenPerHeadFils);
    assertEquals(after.rosterFrozenAt, first.rosterFrozenAt);
  });
});

Deno.test("a freeze that fires before the cutoff reschedules instead", async () => {
  await withTestKv(async (kv) => {
    // Cutoff is still days away — this message arrived too early.
    const { game } = await seedGame(kv, {
      startUtc: futureStart(200),
      cutoffHours: 48,
    });

    const result = await freezeRoster(kv, game.id);
    assertEquals(result.frozen, false);
    assertEquals(result.rescheduled, true);
    assertEquals(
      (await getGame(kv, game.id) as Game).rosterFrozenAt,
      undefined,
    );
  });
});

Deno.test("held seats stay out of the frozen cost", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      startUtc: futureStart(4),
      cutoffHours: 48,
      totalCostFils: 9000,
      courts: 1,
      playersPerCourt: 4,
    });
    const players = await seedPlayers(kv, 5);
    for (const player of players.slice(0, 4)) {
      await joinGame(kv, game.id, player);
    }
    await joinGame(kv, game.id, players[4]!);
    await leaveGame(kv, game.id, players[0]!.id, { byOrganizer: true });
    await promoteNext(kv, game.id);

    const frozen = await getGame(kv, game.id) as Game;
    assertEquals(frozen.pendingCount, 1);
    assertEquals(frozen.confirmedCount, 3);

    await freezeRoster(kv, game.id);
    const after = await getGame(kv, game.id) as Game;
    // Divided between the three who hold seats, not the four occupying them.
    assertEquals(after.frozenPerHeadFils, 3000);
  });
});

// --- The concurrency suite -------------------------------------------------

Deno.test("concurrency: parallel joins never oversell the last seat", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 4, playersPerCourt: 4 });
    const capacity = 16;
    const players = await seedPlayers(kv, 40);

    const results = await Promise.all(
      players.map((player) =>
        joinGame(kv, game.id, player).then((r) => r.outcome).catch(() =>
          "error"
        )
      ),
    );

    const confirmed = results.filter((r) => r === "confirmed").length;
    const waitlisted = results.filter((r) => r === "waitlisted").length;

    assertEquals(confirmed, capacity, "exactly the capacity may be confirmed");
    assertEquals(waitlisted, players.length - capacity);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: two players racing for one seat produce one winner", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    const [first, second] = await Promise.all([
      joinGame(kv, game.id, players[0]!),
      joinGame(kv, game.id, players[1]!),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    assertEquals(outcomes, ["confirmed", "waitlisted"]);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: the waitlist hands out distinct positions", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 12);

    const results = await Promise.all(
      players.map((player) => joinGame(kv, game.id, player)),
    );

    const positions = results
      .filter((r) => r.outcome === "waitlisted")
      .map((r) => r.signup.waitlistSeq);

    assertEquals(
      new Set(positions).size,
      positions.length,
      "two players must never share a waitlist position",
    );
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: joins racing a leave stay within capacity", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 4 });
    const seated = await seedPlayers(kv, 4);
    for (const player of seated) await joinGame(kv, game.id, player);

    const newcomers = await seedPlayers(kv, 6);

    // One seat opens while six people are trying to take it.
    await Promise.all([
      leaveGame(kv, game.id, seated[0]!.id),
      ...newcomers.map((player) =>
        joinGame(kv, game.id, player).catch(() => null)
      ),
    ]);

    await assertSeatsConsistent(kv, game.id);
    const after = await getGame(kv, game.id) as Game;
    assert(
      after.confirmedCount <= capacityOf(after),
      "capacity must hold through the interleaving",
    );
  });
});

Deno.test("concurrency: duplicate promotions never hand out the same seat twice", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 2 });
    const players = await seedPlayers(kv, 5);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    for (const player of players.slice(2)) await joinGame(kv, game.id, player);

    await leaveGame(kv, game.id, players[0]!.id);

    // The queue delivered the same message four times over.
    const promotions = await Promise.all([
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
    ]);

    const succeeded = promotions.filter((p) => p.promoted);
    assertEquals(succeeded.length, 1, "one freed seat promotes one player");
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: guest additions racing joins never oversell", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, {
      courts: 1,
      playersPerCourt: 8,
      maxGuestsPerPlayer: 1,
    });
    const seated = await seedPlayers(kv, 4);
    for (const player of seated) await joinGame(kv, game.id, player);

    const newcomers = await seedPlayers(kv, 8);

    // Four guests and eight players chase the four remaining seats.
    await Promise.all([
      ...seated.map((player) =>
        addGuest(kv, game.id, player.id, { name: "Guest" }).catch(() => null)
      ),
      ...newcomers.map((player) =>
        joinGame(kv, game.id, player).catch(() => null)
      ),
    ]);

    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: a double-submitted join takes only one seat", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 4 });
    const player = await seedPlayer(kv);

    const results = await Promise.allSettled([
      joinGame(kv, game.id, player),
      joinGame(kv, game.id, player),
      joinGame(kv, game.id, player),
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled");
    assertEquals(accepted.length, 1, "a double submit must not seat twice");

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.confirmedCount, 1);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: confirm racing expiry resolves to exactly one outcome", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
    const players = await seedPlayers(kv, 2);

    await joinGame(kv, game.id, players[0]!);
    await joinGame(kv, game.id, players[1]!);
    await leaveGame(kv, game.id, players[0]!.id);
    await promoteNext(kv, game.id);

    const [confirmResult, expiryResult] = await Promise.allSettled([
      confirmPromotion(kv, game.id, players[1]!.id),
      expirePromotion(kv, game.id, players[1]!.id),
    ]);

    // The deadline has not passed, so confirming wins and expiry no-ops.
    assertEquals(confirmResult.status, "fulfilled");
    assertEquals(
      expiryResult.status === "fulfilled" && expiryResult.value.expired,
      false,
    );

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.confirmedCount, 1);
    assertEquals(after.pendingCount, 0);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: parallel leaves never drive counters negative", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 2, playersPerCourt: 4 });
    const players = await seedPlayers(kv, 8);
    for (const player of players) await joinGame(kv, game.id, player);

    await Promise.all(
      players.map((player) =>
        leaveGame(kv, game.id, player.id).catch(() => null)
      ),
    );

    const after = await getGame(kv, game.id) as Game;
    assertEquals(after.confirmedCount, 0);
    assertEquals(after.guestCount, 0);
    await assertSeatsConsistent(kv, game.id);
  });
});

Deno.test("concurrency: a full churn cycle keeps the roster consistent", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { courts: 2, playersPerCourt: 4 });
    const players = await seedPlayers(kv, 20);

    // Everyone piles in.
    await Promise.all(
      players.map((p) => joinGame(kv, game.id, p).catch(() => null)),
    );

    // Half of them change their minds while promotions run.
    await Promise.all([
      ...players.slice(0, 10).map((p) =>
        leaveGame(kv, game.id, p.id).catch(() => null)
      ),
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
    ]);

    // And promotions keep flowing afterwards.
    await Promise.all([
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
      promoteNext(kv, game.id),
    ]);

    await assertSeatsConsistent(kv, game.id);
  });
});
