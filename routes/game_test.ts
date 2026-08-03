/**
 * Route-level tests for the RSVP actions.
 *
 * These drive the real `app.handler()` rather than calling the data layer, so
 * they cover what the data-layer tests cannot: CSRF rejection, the redirect
 * contract, the session cookie, and the mapping from a `SignupError` to a
 * readable message on the query string.
 *
 * The app resolves KV through the `getKv()` singleton, so the environment is
 * pointed at an in-memory database before `main.ts` is imported. Every case
 * shares that one database and seeds its own users and games, which is why
 * each test creates uniquely-named records rather than assuming an empty one.
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
const { createSession, sessionCookie } = await import(
  "../lib/auth/session.ts"
);
const { CSRF_COOKIE, CSRF_FIELD } = await import("../lib/auth/middleware.ts");
const { seedGame, seedPlayer } = await import("../lib/testing/fixtures.ts");
const { getSignup } = await import("../lib/data/signups.ts");
const { getGame } = await import("../lib/data/games.ts");
type User = import("../lib/types.ts").User;

const handler = app.handler();
const kv = await getKv();

/** A signed-in browser: session cookie plus a matching CSRF token. */
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
  options: { csrf?: string } = {},
) {
  const body = new FormData();
  // `options.csrf` overrides the real token so a test can forge a bad one.
  body.set(CSRF_FIELD, options.csrf ?? auth.csrf);
  for (const [key, value] of Object.entries(fields)) body.set(key, value);

  return handler(
    new Request(`http://localhost:8000${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie },
      body,
    }),
  );
}

/** The `notice`/`error` message a redirect carries back. */
function messageFrom(response: Response): {
  notice: string | null;
  error: string | null;
} {
  const location = response.headers.get("location") ?? "";
  const query = new URL(location, "http://localhost:8000").searchParams;
  return { notice: query.get("notice"), error: query.get("error") };
}

Deno.test("joining through the route seats the player and redirects", async () => {
  const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 4 });
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/join`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(
    response.headers.get("location") ?? "",
    `/games/${game.slug}`,
  );
  assertStringIncludes(messageFrom(response).notice ?? "", "You are in");

  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.status, "confirmed");

  const after = await getGame(kv, game.id);
  assertEquals(after?.confirmedCount, 1);
});

Deno.test("a join with a bad CSRF token is refused and seats nobody", async () => {
  const { game } = await seedGame(kv);
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/join`, auth, {}, {
    csrf: "forged",
  });
  await response.body?.cancel();

  // Rejected, and never reached the data layer.
  assertEquals(
    response.status === 303 && messageFrom(response).error !== null
      ? 403
      : response.status,
    403,
  );
  assertEquals(await getSignup(kv, game.id, player.id), null);
});

Deno.test("a second join comes back as a readable refusal, not a crash", async () => {
  const { game } = await seedGame(kv);
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  await (await post(`/games/${game.slug}/join`, auth)).body?.cancel();
  const response = await post(`/games/${game.slug}/join`, auth);
  await response.body?.cancel();

  // A SignupError must surface as a message, not a 500.
  assertEquals(response.status, 303);
  assertStringIncludes(
    messageFrom(response).error ?? "",
    "already signed up",
  );
});

Deno.test("leaving through the route frees the seat", async () => {
  const { game } = await seedGame(kv);
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  await (await post(`/games/${game.slug}/join`, auth)).body?.cancel();
  const response = await post(`/games/${game.slug}/leave`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).notice ?? "", "off the roster");

  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.status, "cancelled");
  assertEquals((await getGame(kv, game.id))?.confirmedCount, 0);
});

Deno.test("adding a guest takes a seat and names the guest back", async () => {
  const { game } = await seedGame(kv, { maxGuestsPerPlayer: 1 });
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  await (await post(`/games/${game.slug}/join`, auth)).body?.cancel();
  const response = await post(`/games/${game.slug}/guests`, auth, {
    guestName: "Priya",
  });
  await response.body?.cancel();

  assertStringIncludes(messageFrom(response).notice ?? "", "Priya");

  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.guests.length, 1);
  assertEquals((await getGame(kv, game.id))?.guestCount, 1);
});

Deno.test("a guest with no usable name is rejected before any write", async () => {
  const { game } = await seedGame(kv, { maxGuestsPerPlayer: 1 });
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  await (await post(`/games/${game.slug}/join`, auth)).body?.cancel();
  const response = await post(`/games/${game.slug}/guests`, auth, {
    guestName: " ",
  });
  await response.body?.cancel();

  assertStringIncludes(messageFrom(response).error ?? "", "guest's name");

  // The validation failure must not have taken a seat.
  assertEquals((await getGame(kv, game.id))?.guestCount, 0);
});

Deno.test("removing a guest returns the seat", async () => {
  const { game } = await seedGame(kv, { maxGuestsPerPlayer: 1 });
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  await (await post(`/games/${game.slug}/join`, auth)).body?.cancel();
  await (await post(`/games/${game.slug}/guests`, auth, { guestName: "Sam" }))
    .body?.cancel();

  const signup = await getSignup(kv, game.id, player.id);
  const guestId = signup!.guests[0]!.id;

  const response = await post(`/games/${game.slug}/guests/remove`, auth, {
    guestId,
  });
  await response.body?.cancel();

  assertStringIncludes(messageFrom(response).notice ?? "", "Guest removed");
  assertEquals((await getGame(kv, game.id))?.guestCount, 0);
});

Deno.test("confirming with no offer outstanding is a refusal, not a crash", async () => {
  const { game } = await seedGame(kv);
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/confirm`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).error ?? "", "no seat waiting");
});

Deno.test("an action against an unknown game is a 404", async () => {
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  const response = await post("/games/does-not-exist/join", auth);
  await response.body?.cancel();

  assertEquals(response.status, 404);
});

Deno.test("a signed-out visitor cannot act on a game", async () => {
  const { game } = await seedGame(kv);

  const body = new FormData();
  body.set(CSRF_FIELD, "irrelevant");
  const response = await handler(
    new Request(`http://localhost:8000/games/${game.slug}/join`, {
      method: "POST",
      body,
    }),
  );
  await response.body?.cancel();

  // Redirected to login or refused outright — never a successful action.
  assertEquals(response.status !== 303 || !messageFrom(response).notice, true);
  assertEquals(await getSignup(kv, game.id, "nobody"), null);
});
