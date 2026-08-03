/**
 * Route-level tests for marking attendance.
 *
 * The rule this pins is that attendance is the organizer's to record. A
 * player marking themselves present would make the show-up rate on the
 * leaderboard worth nothing.
 */

import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

// Must be set before main.ts is imported: getKv() caches the handle it opens.
Deno.env.set("KV_PATH", ":memory:");
Deno.env.set("IBAN_ENC_KEY", encodeBase64(new Uint8Array(32).fill(7)));
Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));
Deno.env.set("APP_URL", "http://localhost:8000");

const { app } = await import("../main.ts");
const { getKv } = await import("../lib/kv/kv.ts");
const { createSession, sessionCookie } = await import(
  "../lib/auth/session.ts"
);
const { CSRF_COOKIE, CSRF_FIELD } = await import("../lib/auth/middleware.ts");
const { seedGame, seedPlayer } = await import("../lib/testing/fixtures.ts");
const { getSignup, joinGame } = await import("../lib/data/signups.ts");
const { getStats } = await import("../lib/data/matches.ts");
type User = import("../lib/types.ts").User;

const handler = app.handler();
const kv = await getKv();

async function signIn(user: User) {
  const session = await createSession(kv, user);
  const csrf = "test-csrf-token";
  const cookie = `${sessionCookie(session.id, false).split(";")[0]}; ` +
    `${CSRF_COOKIE}=${csrf}`;
  return { cookie, csrf };
}

function post(
  path: string,
  auth: { cookie: string; csrf: string },
  fields: Record<string, string> = {},
) {
  const body = new FormData();
  body.set(CSRF_FIELD, auth.csrf);
  for (const [key, value] of Object.entries(fields)) body.set(key, value);

  return handler(
    new Request(`http://localhost:8000${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie },
      body,
    }),
  );
}

async function gameWithPlayer() {
  const { game, groupId, organizer } = await seedGame(kv, {
    courts: 1,
    playersPerCourt: 4,
  });
  const player = await seedPlayer(kv);
  await joinGame(kv, game.id, player);
  return { game, groupId, player, organizer };
}

Deno.test("the organizer marking a player present records it against the group", async () => {
  const { game, groupId, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/attendance`, auth, {
    userId: player.id,
    attended: "1",
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.attendedAt !== undefined, true);
  assertEquals((await getStats(kv, groupId, player.id)).attended, 1);
});

Deno.test("marking a player absent is recorded apart from never marking them", async () => {
  const { game, groupId, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/attendance`, auth, {
    userId: player.id,
    attended: "0",
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  const signup = await getSignup(kv, game.id, player.id);
  // The two fields are mutually exclusive: a no-show is not an absent mark.
  assertEquals(signup?.markedAbsentAt !== undefined, true);
  assertEquals(signup?.attendedAt, undefined);
  assertEquals((await getStats(kv, groupId, player.id)).noShow, 1);
});

Deno.test("correcting a mark moves the tally rather than adding to both", async () => {
  const { game, groupId, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);

  for (const attended of ["1", "0"]) {
    const response = await post(`/games/${game.slug}/attendance`, auth, {
      userId: player.id,
      attended,
    });
    await response.body?.cancel();
  }

  const stats = await getStats(kv, groupId, player.id);
  assertEquals(stats.attended, 0);
  assertEquals(stats.noShow, 1);
});

Deno.test("a player cannot mark their own attendance", async () => {
  const { game, groupId, player } = await gameWithPlayer();
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/attendance`, auth, {
    userId: player.id,
    attended: "1",
  });
  await response.body?.cancel();

  assertEquals(response.status, 403);
  assertEquals(
    (await getSignup(kv, game.id, player.id))?.attendedAt,
    undefined,
  );
  assertEquals((await getStats(kv, groupId, player.id)).attended, 0);
});
