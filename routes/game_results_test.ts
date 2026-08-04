/**
 * Route-level tests for reporting and ruling on results.
 *
 * The rules worth driving through the real handler are the ones that span a
 * request rather than a function call: that a winner forging the confirm POST
 * is still refused even though the UI never shows them the button, and that a
 * match id from another game cannot be acted on under this game's permissions.
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
const { seedGame, seedPlayers } = await import("../lib/testing/fixtures.ts");
const { joinGame } = await import("../lib/data/signups.ts");
const { getStats, listMatchesForGame, reportMatch } = await import(
  "../lib/data/matches.ts"
);
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

function messageFrom(response: Response) {
  const location = response.headers.get("location") ?? "";
  const query = new URL(location, "http://localhost:8000").searchParams;
  return { notice: query.get("notice"), error: query.get("error") };
}

/** A game with four confirmed players, ready for a doubles result. */
async function gameOfFour() {
  const { game, groupId } = await seedGame(kv, {
    courts: 1,
    maxPlayers: 4,
  });
  const players = await seedPlayers(kv, 4);
  for (const player of players) await joinGame(kv, game.id, player);
  return { game, groupId, players };
}

Deno.test("reporting a result through the route leaves it pending", async () => {
  const { game, players } = await gameOfFour();
  const [a, b, c, d] = players;
  const auth = await signIn(a!);

  const response = await post(`/games/${game.slug}/results`, auth, {
    a1: a!.id,
    a2: b!.id,
    b1: c!.id,
    b2: d!.id,
    scoreA: "21",
    scoreB: "15",
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).notice ?? "", "losing side");

  const matches = await listMatchesForGame(kv, game.id);
  assertEquals(matches.length, 1);
  assertEquals(matches[0]?.status, "pending");
});

Deno.test("a reported score that is not a number is refused before the data layer", async () => {
  const { game, players } = await gameOfFour();
  const [a, b, c, d] = players;
  const auth = await signIn(a!);

  const response = await post(`/games/${game.slug}/results`, auth, {
    a1: a!.id,
    a2: b!.id,
    b1: c!.id,
    b2: d!.id,
    scoreA: "twenty-one",
    scoreB: "15",
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).error ?? "", "whole numbers");
  assertEquals((await listMatchesForGame(kv, game.id)).length, 0);
});

Deno.test("a draw comes back as a readable refusal", async () => {
  const { game, players } = await gameOfFour();
  const [a, b, c, d] = players;
  const auth = await signIn(a!);

  const response = await post(`/games/${game.slug}/results`, auth, {
    a1: a!.id,
    a2: b!.id,
    b1: c!.id,
    b2: d!.id,
    scoreA: "21",
    scoreB: "21",
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).error ?? "", "end level");
});

Deno.test("the losing side confirming moves everyone's record", async () => {
  const { game, groupId, players } = await gameOfFour();
  const [a, b, c, d] = players;

  const match = await reportMatch(kv, {
    gameId: game.id,
    groupId,
    sideA: [a!.id, b!.id],
    sideB: [c!.id, d!.id],
    scoreA: 21,
    scoreB: 15,
    reportedBy: a!.id,
  });

  const auth = await signIn(c!);
  const response = await post(`/games/${game.slug}/results/confirm`, auth, {
    matchId: match.id,
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertEquals((await getStats(kv, groupId, a!.id)).wins, 1);
  assertEquals((await getStats(kv, groupId, c!.id)).losses, 1);
});

Deno.test("a winner forging the confirm POST is still refused", async () => {
  const { game, groupId, players } = await gameOfFour();
  const [a, b, c, d] = players;

  const match = await reportMatch(kv, {
    gameId: game.id,
    groupId,
    sideA: [a!.id, b!.id],
    sideB: [c!.id, d!.id],
    scoreA: 21,
    scoreB: 15,
    reportedBy: a!.id,
  });

  // The UI never renders this button for a winner. That is a courtesy; this
  // is the control.
  const auth = await signIn(a!);
  const response = await post(`/games/${game.slug}/results/confirm`, auth, {
    matchId: match.id,
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertEquals(messageFrom(response).error !== null, true);
  assertEquals((await getStats(kv, groupId, a!.id)).wins, 0);
});

Deno.test("a match id from another game cannot be ruled on here", async () => {
  const first = await gameOfFour();
  const second = await gameOfFour();
  const [a, b, c, d] = first.players;

  const match = await reportMatch(kv, {
    gameId: first.game.id,
    groupId: first.groupId,
    sideA: [a!.id, b!.id],
    sideB: [c!.id, d!.id],
    scoreA: 21,
    scoreB: 15,
    reportedBy: a!.id,
  });

  // c is on the losing side and would be allowed to confirm — but not through
  // a game whose permissions were never checked against this match.
  const auth = await signIn(c!);
  const response = await post(
    `/games/${second.game.slug}/results/confirm`,
    auth,
    { matchId: match.id },
  );
  await response.body?.cancel();

  assertEquals(response.status, 404);
  assertEquals((await getStats(kv, first.groupId, a!.id)).wins, 0);
});
