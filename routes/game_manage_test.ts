/**
 * Route-level tests for the organizer's controls over a game: posting one
 * without a club, editing, deleting, and removing a player from the roster.
 *
 * These drive the real handler for the same reason the RSVP tests do — the
 * interesting parts are the guards and the redirects, and neither exists in
 * the data layer.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

// Must be set before main.ts is imported: getKv() caches the handle it opens.
Deno.env.set("KV_PATH", ":memory:");
Deno.env.set("IBAN_ENC_KEY", encodeBase64(new Uint8Array(32).fill(7)));
Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));
Deno.env.set("APP_URL", "http://localhost:8000");

const { app } = await import("../main.ts");
const { getKv } = await import("../lib/kv/kv.ts");
const { createSession, sessionCookie } = await import("../lib/auth/session.ts");
const { CSRF_COOKIE, CSRF_FIELD } = await import("../lib/auth/middleware.ts");
const { seedGame, seedMember, seedPlayer } = await import(
  "../lib/testing/fixtures.ts"
);
const { getGameBySlug } = await import("../lib/data/games.ts");
const { getSignup, joinGame } = await import("../lib/data/signups.ts");
const { createUser, updateUser } = await import("../lib/data/users.ts");
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

function get(path: string, auth: { cookie: string }) {
  return handler(
    new Request(`http://localhost:8000${path}`, {
      headers: { cookie: auth.cookie },
    }),
  );
}

/** A player who can be put on a roster: the games list needs a phone. */
async function seedReachable(): Promise<User> {
  const player = await seedPlayer(kv);
  return await updateUser(kv, player.id, {
    phone: `+9715${Math.floor(1_0000000 + Math.random() * 8_999_999)}`,
  }) as User;
}

/** The fields a valid new-game form carries. */
function gameFields(overrides: Record<string, string> = {}) {
  const start = new Date(Date.now() + 96 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const local = (at: Date) => at.toISOString().slice(0, 16);

  return {
    title: "Friday Doubles",
    sport: "padel",
    venueName: "Al Nasr",
    venueAddress: "Oud Metha, Dubai",
    start: local(start),
    end: local(end),
    cutoffHours: "48",
    courts: "3",
    maxPlayers: "10",
    pricePerPlayer: "30",
    maxGuests: "1",
    skillMin: "",
    skillMax: "",
    visibility: "public",
    ...overrides,
  };
}

Deno.test("a player cannot approve their own access request", async () => {
  const { game } = await seedGame(kv, { visibility: "password" });
  const player = await seedReachable();
  const auth = await signIn(player);

  await (await post(`/games/${game.slug}/access/request`, auth)).body?.cancel();

  // The whole point of the lock: asking is open to anyone, answering is not.
  const response = await post(`/games/${game.slug}/access/decide`, auth, {
    userId: player.id,
    decision: "approve",
  });
  await response.body?.cancel();

  const { hasUnlocked } = await import("../lib/domain/game_access.ts");
  assertEquals(await hasUnlocked(kv, game, player.id), false);
});

Deno.test("the organizer approving lets the player take a seat", async () => {
  const { game, organizer } = await seedGame(kv, { visibility: "password" });
  const player = await seedReachable();
  const playerAuth = await signIn(player);
  const organizerAuth = await signIn(organizer);

  await (await post(`/games/${game.slug}/access/request`, playerAuth)).body
    ?.cancel();
  await (await post(`/games/${game.slug}/access/decide`, organizerAuth, {
    userId: player.id,
    decision: "approve",
  })).body?.cancel();

  // Joining now works without ever entering the code.
  const join = await post(`/games/${game.slug}/join`, playerAuth);
  await join.body?.cancel();

  assertEquals((await getSignup(kv, game.id, player.id))?.status, "confirmed");
});

Deno.test("the preset carries a game's settings without its date", async () => {
  const organizer = await seedReachable();
  const auth = await signIn(organizer);

  // A password game, because visibility is the setting most costly to lose:
  // silently reverting it to public would expose the next game's roster.
  await (await post(
    "/games",
    auth,
    gameFields({
      title: "Tuesday Regulars",
      venueName: "Al Quoz Hall",
      pricePerPlayer: "45",
      visibility: "password",
      skillMin: "intermediate",
    }),
  )).body?.cancel();

  const response = await get("/games/new?preset=1", auth);
  const html = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(html, 'value="Tuesday Regulars"');
  assertStringIncludes(html, 'value="Al Quoz Hall"');
  assertStringIncludes(html, 'value="45"');
  // The two selects that used to read past `values` and revert to their
  // defaults.
  assertStringIncludes(html, '<option value="password" selected');
  assertStringIncludes(html, 'value="intermediate" selected');

  // The start time is the one field that must not carry over — last week's
  // date in front of someone posting next week's game. Preact renders an empty
  // attribute as a bare `value`, so that is what an unfilled field looks like.
  assertStringIncludes(html, 'value id="start"');
});

Deno.test("the preset is offered but not applied until asked for", async () => {
  const organizer = await seedReachable();
  const auth = await signIn(organizer);

  await (await post("/games", auth, gameFields({ title: "Sunday Social" })))
    .body?.cancel();

  const html = await (await get("/games/new", auth)).text();

  // Offered by name, so the organizer knows what they would be copying.
  assertStringIncludes(html, "Sunday Social");
  assertStringIncludes(html, "?preset=1");
  // But the form itself is still empty.
  assertStringIncludes(html, 'value placeholder="Sunday Doubles"');
});

Deno.test("a player in no club can post a game, and it belongs to them", async () => {
  const player = await seedReachable();
  const auth = await signIn(player);

  const response = await post("/games", auth, gameFields());
  await response.body?.cancel();

  assertEquals(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assertStringIncludes(location, "posted=1");

  const slug = location.replace("/games/", "").split("?")[0]!;
  const game = await getGameBySlug(kv, slug);

  assertEquals(game?.groupId, null);
  assertEquals(game?.createdBy, player.id);
  assertEquals(game?.sport, "padel");
  // Capacity is what was asked for, not courts multiplied by anything.
  assertEquals(game?.maxPlayers, 10);
  assertEquals(game?.courts, 3);
});

Deno.test("the creator of a clubless game may edit it", async () => {
  const player = await seedReachable();
  const auth = await signIn(player);

  const created = await post("/games", auth, gameFields());
  await created.body?.cancel();
  const slug = (created.headers.get("location") ?? "")
    .replace("/games/", "").split("?")[0]!;

  const response = await post(
    `/games/${slug}`,
    auth,
    gameFields({ title: "Renamed Game", maxPlayers: "6" }),
  );
  await response.body?.cancel();

  assertEquals(response.status, 302);
  const game = await getGameBySlug(kv, slug);
  assertEquals(game?.title, "Renamed Game");
  assertEquals(game?.maxPlayers, 6);
});

Deno.test("a stranger cannot edit someone else's clubless game", async () => {
  const owner = await seedReachable();
  const created = await post("/games", await signIn(owner), gameFields());
  await created.body?.cancel();
  const slug = (created.headers.get("location") ?? "")
    .replace("/games/", "").split("?")[0]!;

  const stranger = await seedReachable();
  const response = await post(
    `/games/${slug}`,
    await signIn(stranger),
    gameFields({ title: "Hijacked" }),
  );
  await response.body?.cancel();

  assertEquals(response.status, 403);
  const game = await getGameBySlug(kv, slug);
  assertEquals(game?.title, "Friday Doubles");
});

Deno.test("deleting a game hides it but keeps the roster", async () => {
  const { game, groupId, organizer } = await seedGame(kv, { maxPlayers: 4 });
  const player = await seedReachable();
  await seedMember(kv, groupId, player);
  await joinGame(kv, game.id, player);

  const response = await post(
    `/games/${game.slug}/delete`,
    await signIn(organizer),
  );
  await response.body?.cancel();

  assertEquals(response.status, 302);

  // Gone from every ordinary read, so nobody can open or join it.
  assertEquals(await getGameBySlug(kv, game.slug), null);

  // The record and the roster survive: someone may have paid into this.
  const kept = await getGameBySlug(kv, game.slug, { includeDeleted: true });
  assertEquals(kept?.deletedBy, organizer.id);
  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.status, "confirmed");
});

Deno.test("a player cannot delete a game they merely joined", async () => {
  const { game, groupId } = await seedGame(kv, { maxPlayers: 4 });
  const player = await seedReachable();
  await seedMember(kv, groupId, player);
  await joinGame(kv, game.id, player);

  const response = await post(
    `/games/${game.slug}/delete`,
    await signIn(player),
  );
  await response.body?.cancel();

  assertEquals(response.status, 403);
  assertEquals((await getGameBySlug(kv, game.slug))?.id, game.id);
});

Deno.test("the super admin can delete a game organized by someone else", async () => {
  const { game } = await seedGame(kv, { maxPlayers: 4 });

  // The platform administrator, who runs no club and joined no game here.
  const admin = await createUser(kv, {
    email: `admin-${crypto.randomUUID()}@example.com`,
    name: "Administrator",
    role: "super_admin",
  });

  const response = await post(
    `/games/${game.slug}/delete`,
    await signIn(admin),
  );
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertEquals(await getGameBySlug(kv, game.slug), null);
});

Deno.test("an organizer removes a player without charging them", async () => {
  // Past the cutoff, where a player cancelling on their own would forfeit.
  const { game, groupId, organizer } = await seedGame(kv, {
    maxPlayers: 4,
    cutoffHours: 2,
    startUtc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const player = await seedReachable();
  await seedMember(kv, groupId, player);
  await joinGame(kv, game.id, player);

  const response = await post(
    `/games/${game.slug}/remove`,
    await signIn(organizer),
    { userId: player.id },
  );
  await response.body?.cancel();

  assertEquals(response.status, 303);

  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.status, "cancelled");
  // Removed by the organizer, so the share is not forfeited: they chose
  // nothing, and billing them would take the organizer's side.
  assertEquals(signup?.payment, "unpaid");
});

Deno.test("a player cannot remove another player", async () => {
  const { game, groupId } = await seedGame(kv, { maxPlayers: 4 });
  const [one, two] = [await seedReachable(), await seedReachable()];
  await seedMember(kv, groupId, one);
  await seedMember(kv, groupId, two);
  await joinGame(kv, game.id, two);

  const response = await post(
    `/games/${game.slug}/remove`,
    await signIn(one),
    { userId: two.id },
  );
  await response.body?.cancel();

  assertEquals(response.status, 403);
  assertEquals((await getSignup(kv, game.id, two.id))?.status, "confirmed");
});

Deno.test("the games list filters by sport and searches by venue", async () => {
  const player = await seedReachable();
  const auth = await signIn(player);

  await (await post(
    "/games",
    auth,
    gameFields({
      title: "Padel Night",
      sport: "padel",
      venueName: "Marina Courts",
    }),
  )).body?.cancel();

  await (await post(
    "/games",
    auth,
    gameFields({
      title: "Squash Ladder",
      sport: "squash",
      venueName: "Deira Club",
    }),
  )).body?.cancel();

  const filtered = await get("/games?sport=squash", auth);
  const body = await filtered.text();
  assertEquals(filtered.status, 200);
  assertStringIncludes(body, "Squash Ladder");
  assertEquals(body.includes("Padel Night"), false);

  const searched = await get("/games?q=marina", auth);
  const searchBody = await searched.text();
  assertStringIncludes(searchBody, "Padel Night");
  assertEquals(searchBody.includes("Squash Ladder"), false);
});
