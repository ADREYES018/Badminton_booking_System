/**
 * Asking to be let into a locked game, and the organizer's answer.
 *
 * The load-bearing case is that approval unlocks without seating: the two are
 * separate steps by design, and collapsing them would bill a player for a seat
 * they never accepted.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { withTestKv } from "../testing/kv_test_helper.ts";
import { seedGame, seedPlayer } from "../testing/fixtures.ts";
import { hasUnlocked } from "../domain/game_access.ts";
import { getSignup } from "./signups.ts";
import {
  AccessRequestError,
  approveAccess,
  getAccessRequest,
  listAccessRequests,
  rejectAccess,
  requestAccess,
} from "./access_requests.ts";

Deno.test("approval unlocks the game without taking a seat", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, { visibility: "password" });
    const player = await seedPlayer(kv);

    assertEquals(await hasUnlocked(kv, game, player.id), false);

    await requestAccess(kv, game, player.id, "I play with Sam");
    await approveAccess(kv, game.id, player.id, organizer.id);

    // The door is open...
    assertEquals(await hasUnlocked(kv, game, player.id), true);
    // ...but they are not on the roster and owe nothing until they join.
    assertEquals(await getSignup(kv, game.id, player.id), null);
  });
});

Deno.test("a refusal leaves the game locked", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, { visibility: "password" });
    const player = await seedPlayer(kv);

    await requestAccess(kv, game, player.id);
    await rejectAccess(kv, game.id, player.id, organizer.id);

    assertEquals(await hasUnlocked(kv, game, player.id), false);
    assertEquals(
      (await getAccessRequest(kv, game.id, player.id))?.status,
      "rejected",
    );
  });
});

Deno.test("asking twice does not queue twice", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { visibility: "password" });
    const player = await seedPlayer(kv);

    const first = await requestAccess(kv, game, player.id, "first");
    const second = await requestAccess(kv, game, player.id, "second");

    // The original stands, timestamp and message included — a resubmit must
    // not push them back down the organizer's list.
    assertEquals(second.requestedAt, first.requestedAt);
    assertEquals(second.message, "first");
    assertEquals((await listAccessRequests(kv, game.id)).length, 1);
  });
});

Deno.test("a refused player may ask again", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, { visibility: "password" });
    const player = await seedPlayer(kv);

    await requestAccess(kv, game, player.id);
    await rejectAccess(kv, game.id, player.id, organizer.id);

    // A refusal is an answer to one request, not a standing ban.
    const again = await requestAccess(kv, game, player.id, "changed my mind");
    assertEquals(again.status, "pending");
    assertEquals(again.message, "changed my mind");
  });
});

Deno.test("deciding the same request twice is refused", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, { visibility: "password" });
    const player = await seedPlayer(kv);

    await requestAccess(kv, game, player.id);
    await approveAccess(kv, game.id, player.id, organizer.id);

    // A double-tapped button, or a second organizer. The first answer stands.
    await assertRejects(
      () => rejectAccess(kv, game.id, player.id, organizer.id),
      AccessRequestError,
    );
    assertEquals(await hasUnlocked(kv, game, player.id), true);
  });
});

Deno.test("a public game has nothing to ask for", async () => {
  await withTestKv(async (kv) => {
    const { game } = await seedGame(kv, { visibility: "public" });
    const player = await seedPlayer(kv);

    await assertRejects(
      () => requestAccess(kv, game, player.id),
      AccessRequestError,
    );
  });
});

Deno.test("an unlisted game can be asked about too", async () => {
  await withTestKv(async (kv) => {
    const { game, organizer } = await seedGame(kv, { visibility: "unlisted" });
    const player = await seedPlayer(kv);

    const request = await requestAccess(kv, game, player.id);
    assertEquals(request.status, "pending");

    await approveAccess(kv, game.id, player.id, organizer.id);
    assertEquals(
      (await getAccessRequest(kv, game.id, player.id))?.status,
      "approved",
    );
  });
});
