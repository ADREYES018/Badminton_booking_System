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
const { ensureMembership, getGroup } = await import("../lib/data/groups.ts");
const { getStats } = await import("../lib/data/matches.ts");
const { checkinVersionOf, mintCheckinToken } = await import(
  "../lib/domain/checkin.ts"
);
const { getUser, updateUser } = await import("../lib/data/users.ts");
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
  const token = await mintCheckinToken(player.id);

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
  const token = await mintCheckinToken(player.id);

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
  const token = await mintCheckinToken(player.id);

  for (let i = 0; i < 2; i++) {
    const response = await post(`/games/${game.slug}/checkin`, auth, { token });
    await response.body?.cancel();
  }

  assertEquals((await getStats(kv, groupId, player.id)).attended, 1);
});

Deno.test("a code for someone not on the roster is refused", async () => {
  // The token is genuine and the scanner is a real organizer. Before this
  // phase the game inside the token refused this; now the roster does.
  const { game, organizer } = await gameWithPlayer();
  const outsider = await seedPlayer(kv);
  const auth = await signIn(organizer);

  const token = await mintCheckinToken(outsider.id);
  const response = await post(`/games/${game.slug}/checkin`, auth, { token });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.ok, false);
});

Deno.test("a code carrying no game still marks a confirmed player present", async () => {
  // The same protection the deleted per-game test gave, now proved through a
  // token that names only the player.
  const { game, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/checkin`, auth, {
    token: await mintCheckinToken(player.id),
  });

  assertEquals(response.status, 200);
  assertEquals((await response.json()).userId, player.id);
  assertEquals(
    typeof (await getSignup(kv, game.id, player.id))?.attendedAt,
    "string",
  );
});

Deno.test("the check-in page shows one code however many games are open", async () => {
  // Both games have to be past their cutoff to appear at all, so the cutoff is
  // set wider than the 96-hour default start the fixture uses.
  const { game: first, groupId } = await seedGame(kv, { cutoffHours: 200 });
  const second = await seedGame(kv, { cutoffHours: 200 });
  const player = await seedPlayer(kv);
  // The page is club-only, so a roster seat is not on its own enough to see it.
  await ensureMembership(kv, groupId, player.id);
  await joinGame(kv, first.id, player);
  await joinGame(kv, second.game.id, player);

  const group = (await getGroup(kv, groupId))!;
  const { cookie } = await signIn(player);

  const response = await handler(
    new Request(`http://localhost:8000/g/${group.slug}/checkin`, {
      headers: { cookie },
    }),
  );

  const html = await response.text();
  assertEquals(response.status, 200);
  // One QR, not one per game. Counted by the QR's own label rather than
  // `role="img"`, which the page chrome's logo also carries.
  assertEquals(html.split('aria-label="Your check-in QR code"').length - 1, 1);
  // And both games still named, so the player knows where it works.
  assertEquals(html.includes(`/games/${first.slug}`), true);
  assertEquals(html.includes(`/games/${second.game.slug}`), true);
});

Deno.test("replacing a code retires the previous one", async () => {
  const player = await seedPlayer(kv);
  const before = checkinVersionOf((await getUser(kv, player.id))!);

  const auth = await signIn(player);
  const response = await post("/profile", auth, { replaceCheckinCode: "1" });
  await response.body?.cancel();

  assertEquals(response.status < 400, true);
  assertEquals(checkinVersionOf((await getUser(kv, player.id))!), before + 1);
});

Deno.test("a superseded code is refused after the player replaces it", async () => {
  const { game, player, organizer } = await gameWithPlayer();

  const leaked = await mintCheckinToken(player.id, 1);
  await updateUser(kv, player.id, { checkinVersion: 2 });

  const auth = await signIn(organizer);
  const response = await post(`/games/${game.slug}/checkin`, auth, {
    token: leaked,
  });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.ok, false);
  assertEquals(
    (await getSignup(kv, game.id, player.id))?.attendedAt,
    undefined,
  );
});
