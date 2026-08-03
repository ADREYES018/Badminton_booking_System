/**
 * Route-level tests for scanning a check-in code.
 *
 * The rule that matters most is the direction of the scan: the POST comes
 * from the organizer's browser carrying a token the player displayed, so the
 * organizer guard on `setAttendance` still applies. A player replaying their
 * own token must not be able to mark themselves present.
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
const { mintCheckinToken } = await import("../lib/domain/checkin.ts");
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

Deno.test("a scanned code marks the player present and names them back", async () => {
  const { game, groupId, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);
  const token = await mintCheckinToken(game.id, player.id);

  const response = await post(`/games/${game.slug}/checkin`, auth, { token });
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.userId, player.id);

  assertEquals(
    (await getSignup(kv, game.id, player.id))?.attendedAt !== undefined,
    true,
  );
  assertEquals((await getStats(kv, groupId, player.id)).attended, 1);
});

Deno.test("a player cannot scan their own code to mark themselves in", async () => {
  const { game, groupId, player } = await gameWithPlayer();
  const auth = await signIn(player);
  const token = await mintCheckinToken(game.id, player.id);

  // The token is genuinely theirs. The guard is what refuses this, which is
  // the whole reason the scan points from the organizer to the player.
  const response = await post(`/games/${game.slug}/checkin`, auth, { token });
  await response.body?.cancel();

  assertEquals(response.status, 403);
  assertEquals(
    (await getSignup(kv, game.id, player.id))?.attendedAt,
    undefined,
  );
  assertEquals((await getStats(kv, groupId, player.id)).attended, 0);
});

Deno.test("a code minted for another game is refused", async () => {
  const first = await gameWithPlayer();
  const second = await gameWithPlayer();
  const auth = await signIn(second.organizer);

  const token = await mintCheckinToken(first.game.id, first.player.id);
  const response = await post(`/games/${second.game.slug}/checkin`, auth, {
    token,
  });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.ok, false);
  assertEquals(
    (await getSignup(kv, first.game.id, first.player.id))?.attendedAt,
    undefined,
  );
});

Deno.test("an unreadable code comes back as a message, not a crash", async () => {
  const { game, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/checkin`, auth, {
    token: "not-a-real-code",
  });
  const body = await response.json();

  // A stale screenshot at a door is an ordinary event, not a server error.
  assertEquals(response.status, 400);
  assertEquals(body.ok, false);
  assertEquals(typeof body.error, "string");
});

Deno.test("scanning the same code twice does not double-count", async () => {
  const { game, groupId, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);
  const token = await mintCheckinToken(game.id, player.id);

  for (let i = 0; i < 2; i++) {
    const response = await post(`/games/${game.slug}/checkin`, auth, { token });
    await response.body?.cancel();
  }

  assertEquals((await getStats(kv, groupId, player.id)).attended, 1);
});

Deno.test("a code for someone not on the roster is refused", async () => {
  const { game, organizer } = await gameWithPlayer();
  const outsider = await seedPlayer(kv);
  const auth = await signIn(organizer);

  const token = await mintCheckinToken(game.id, outsider.id);
  const response = await post(`/games/${game.slug}/checkin`, auth, { token });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.ok, false);
});
