import { assertEquals, assertExists } from "@std/assert";
import { withTestKv } from "../testing/kv_test_helper.ts";
import { futureStart, seedGame } from "../testing/fixtures.ts";
import {
  affectsCutoff,
  cancelGame,
  createGame,
  getGameBySlug,
  listGamesByGroup,
  listOpenGames,
  updateGame,
} from "./games.ts";
import { keys } from "../kv/keys.ts";

Deno.test("a created game is reachable by slug and appears in both listings", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId } = await seedGame(kv);

    const bySlug = await getGameBySlug(kv, game.slug);
    assertEquals(bySlug?.id, game.id);

    const open = await listOpenGames(kv, groupId);
    assertEquals(open.map((g) => g.id), [game.id]);

    const byGroup = await listGamesByGroup(kv, groupId);
    assertEquals(byGroup.map((g) => g.id), [game.id]);
  });
});

Deno.test("a new game starts with every seat counter at zero", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    assertEquals(game.confirmedCount, 0);
    assertEquals(game.pendingCount, 0);
    assertEquals(game.waitlistCount, 0);
    assertEquals(game.guestCount, 0);
  });
});

Deno.test("two games with the same title get distinct slugs", async () => {
  await withTestKv(async (kv) => {
    const { game: first, groupId, organizer } = await seedGame(kv);
    const second = await createGame(kv, {
      groupId,
      title: "Test Session",
      venue: { name: "Test Courts", address: "Dubai" },
      startUtc: futureStart(120),
      endUtc: futureStart(122),
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      cutoffHours: 48,
      createdBy: organizer.id,
    });

    assertEquals(first.slug === second.slug, false);
    assertExists(await getGameBySlug(kv, second.slug));
  });
});

Deno.test("an unlisted game is absent from the public listing but readable by slug", async () => {
  await withTestKv(async (kv) => {
    const { groupId, organizer } = await seedGame(kv);
    const hidden = await createGame(kv, {
      groupId,
      title: "Private Session",
      venue: { name: "Test Courts", address: "Dubai" },
      startUtc: futureStart(120),
      endUtc: futureStart(122),
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      cutoffHours: 48,
      createdBy: organizer.id,
      visibility: "unlisted",
    });

    const open = await listOpenGames(kv, groupId);
    assertEquals(open.some((g) => g.id === hidden.id), false);
    assertExists(await getGameBySlug(kv, hidden.slug));
  });
});

Deno.test("moving a game's start time moves both index pointers", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId } = await seedGame(kv);
    const movedTo = futureStart(200);

    await updateGame(kv, game.id, { startUtc: movedTo });

    // The old pointers must be gone, not merely shadowed by new ones.
    const stalePublic = await kv.get(
      keys.gamesOpen(groupId, game.startUtc, game.id),
    );
    assertEquals(stalePublic.value, null);
    const staleGroup = await kv.get(
      keys.gamesByGroup(groupId, game.startUtc, game.id),
    );
    assertEquals(staleGroup.value, null);

    // And exactly one entry should remain in each listing.
    assertEquals((await listOpenGames(kv, groupId)).length, 1);
    assertEquals((await listGamesByGroup(kv, groupId)).length, 1);
  });
});

Deno.test("cancelling removes a game from the public listing but keeps the record", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId } = await seedGame(kv);

    const cancelled = await cancelGame(kv, game.id, "Court flooded");
    assertEquals(cancelled.status, "cancelled");
    assertEquals(cancelled.cancelledReason, "Court flooded");

    assertEquals((await listOpenGames(kv, groupId)).length, 0);
    // The organizer still needs to see it, and the slug still resolves.
    assertEquals((await listGamesByGroup(kv, groupId)).length, 1);
    assertExists(await getGameBySlug(kv, game.slug));
  });
});

Deno.test("making a game unlisted withdraws it from the public listing", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId } = await seedGame(kv);
    await updateGame(kv, game.id, { visibility: "unlisted" });
    assertEquals((await listOpenGames(kv, groupId)).length, 0);
  });
});

Deno.test("re-publishing an unlisted game restores the listing entry", async () => {
  await withTestKv(async (kv) => {
    const { game, groupId } = await seedGame(kv);
    await updateGame(kv, game.id, { visibility: "unlisted" });
    await updateGame(kv, game.id, { visibility: "public" });
    assertEquals((await listOpenGames(kv, groupId)).map((g) => g.id), [
      game.id,
    ]);
  });
});

Deno.test("past games drop out of the upcoming listing", async () => {
  await withTestKv(async (kv) => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { groupId } = await seedGame(kv, { startUtc: yesterday });
    assertEquals((await listOpenGames(kv, groupId)).length, 0);
  });
});

Deno.test("upcoming games are listed soonest first", async () => {
  await withTestKv(async (kv) => {
    const { groupId, organizer } = await seedGame(kv, {
      startUtc: futureStart(200),
    });
    const sooner = await createGame(kv, {
      groupId,
      title: "Sooner",
      venue: { name: "Test Courts", address: "Dubai" },
      startUtc: futureStart(50),
      endUtc: futureStart(52),
      courts: 1,
      playersPerCourt: 4,
      pricePerPlayerFils: 3000,
      cutoffHours: 48,
      createdBy: organizer.id,
    });

    const open = await listOpenGames(kv, groupId);
    assertEquals(open.at(0)?.id, sooner.id);
  });
});

Deno.test("affectsCutoff spots the fields that move the freeze deadline", () => {
  assertEquals(affectsCutoff({ startUtc: futureStart() }), true);
  assertEquals(affectsCutoff({ cutoffHours: 24 }), true);
  assertEquals(affectsCutoff({ title: "Renamed" }), false);
});

Deno.test("clearing a skill bound removes it rather than storing null", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv);
    await updateGame(kv, game.id, { skillMin: "advanced" });
    const cleared = await updateGame(kv, game.id, { skillMin: null });
    assertEquals(cleared.skillMin, undefined);
  });
});
