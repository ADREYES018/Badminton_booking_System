/**
 * Route-level tests for the payment actions.
 *
 * These drive the real handler, so they cover what the data-layer tests
 * cannot: the organizer guard, the redirect target, and the mapping from a
 * refusal to a readable message rather than a stack trace.
 *
 * The rules worth pinning here are the ones a UI change could quietly break —
 * that a player cannot confirm their own payment, and that paying before the
 * roster freezes is refused.
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
const { freezeRoster, getSignup, joinGame } = await import(
  "../lib/data/signups.ts"
);
type User = import("../lib/types.ts").User;

const handler = app.handler();
const kv = await getKv();
const HOUR_MS = 60 * 60 * 1000;

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

/**
 * A game whose cutoff has passed, with one confirmed player and shares frozen.
 *
 * The cutoff must be behind us for the freeze, but the game itself must not
 * have started or nobody could have joined. One hour ahead with a two-hour
 * cutoff satisfies both.
 */
async function frozenGame() {
  const { game, organizer } = await seedGame(kv, {
    courts: 1,
    playersPerCourt: 4,
    totalCostFils: 12000,
    cutoffHours: 2,
    startUtc: new Date(Date.now() + HOUR_MS).toISOString(),
  });
  const player = await seedPlayer(kv);
  await joinGame(kv, game.id, player);
  await freezeRoster(kv, game.id);
  return { game, player, organizer };
}

Deno.test("a player marking their share paid records a claim, not a confirmation", async () => {
  const { game, player } = await frozenGame();
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/paid`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).notice ?? "", "confirm it");

  // The player's word, not the organizer's.
  assertEquals(
    (await getSignup(kv, game.id, player.id))?.payment,
    "marked_paid",
  );
});

Deno.test("paying before the roster freezes comes back as a refusal", async () => {
  // Cutoff still ahead, so nothing has a share yet.
  const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 4 });
  const player = await seedPlayer(kv);
  await joinGame(kv, game.id, player);
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/paid`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).error ?? "", "not closed yet");
  assertEquals((await getSignup(kv, game.id, player.id))?.payment, "unpaid");
});

Deno.test("a player cannot confirm their own payment", async () => {
  const { game, player } = await frozenGame();
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/payments/confirm`, auth, {
    userId: player.id,
  });
  await response.body?.cancel();

  assertEquals(response.status, 403);
  // Still only a claim at most — the authoritative state never moved.
  assertEquals((await getSignup(kv, game.id, player.id))?.payment, "unpaid");
});

Deno.test("the organizer confirming a payment settles it and returns to settlement", async () => {
  const { game, player, organizer } = await frozenGame();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/payments/confirm`, auth, {
    userId: player.id,
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(
    response.headers.get("location") ?? "",
    `/organizer/games/${game.slug}/settlement`,
  );
  assertEquals((await getSignup(kv, game.id, player.id))?.payment, "paid");
});

Deno.test("refunding a share nobody paid is refused", async () => {
  const { game, player, organizer } = await frozenGame();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/payments/refund`, auth, {
    userId: player.id,
  });
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(messageFrom(response).error ?? "", "confirmed payment");
  assertEquals((await getSignup(kv, game.id, player.id))?.payment, "unpaid");
});

Deno.test("a player cannot open another game's settlement screen", async () => {
  const { game } = await frozenGame();
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  const response = await handler(
    new Request(
      `http://localhost:8000/organizer/games/${game.slug}/settlement`,
      { headers: { cookie: auth.cookie } },
    ),
  );
  await response.body?.cancel();

  assertEquals(response.status, 403);
});
