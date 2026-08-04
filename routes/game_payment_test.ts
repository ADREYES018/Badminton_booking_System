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
const { listAudit } = await import("../lib/data/audit.ts");
const { createGroupForOwner, DEFAULT_GROUP_SLUG } = await import(
  "../lib/data/groups.ts"
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
  const { game, organizer, groupId } = await seedGame(kv, {
    courts: 1,
    maxPlayers: 4,
    pricePerPlayerFils: 3000,
    cutoffHours: 2,
    startUtc: new Date(Date.now() + HOUR_MS).toISOString(),
  });
  const player = await seedPlayer(kv);
  await joinGame(kv, game.id, player);
  await freezeRoster(kv, game.id);
  return { game, player, organizer, groupId };
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

Deno.test("taking a seat lands the player on the payment prompt", async () => {
  // Players pay up front, so the transfer details have to arrive while they
  // are still looking at their phone rather than waiting in a panel they
  // scroll past.
  const { game } = await seedGame(kv, {
    courts: 1,
    maxPlayers: 4,
    pricePerPlayerFils: 3000,
  });
  const player = await seedPlayer(kv);
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/join`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertStringIncludes(response.headers.get("location") ?? "", "pay=1");
});

Deno.test("joining the waitlist does not prompt for payment", async () => {
  // A waitlisted player holds no seat and owes nothing yet.
  const { game } = await seedGame(kv, { courts: 1, playersPerCourt: 1 });
  const seated = await seedPlayer(kv);
  await joinGame(kv, game.id, seated);

  const waiting = await seedPlayer(kv);
  const response = await post(
    `/games/${game.slug}/join`,
    await signIn(waiting),
  );
  await response.body?.cancel();

  assertEquals(response.status, 303);
  assertEquals(
    (response.headers.get("location") ?? "").includes("pay=1"),
    false,
  );
});

Deno.test("a player can pay before the roster freezes", async () => {
  // Players pay up front, and a fixed price means there is a real figure to
  // pay against while the roster is still open.
  const { game } = await seedGame(kv, {
    courts: 1,
    maxPlayers: 4,
    pricePerPlayerFils: 3000,
  });
  const player = await seedPlayer(kv);
  await joinGame(kv, game.id, player);
  const auth = await signIn(player);

  const response = await post(`/games/${game.slug}/paid`, auth);
  await response.body?.cancel();

  assertEquals(response.status, 303);
  const signup = await getSignup(kv, game.id, player.id);
  assertEquals(signup?.payment, "marked_paid");
  assertEquals(signup?.owedFils, 3000);
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
    `/g/${DEFAULT_GROUP_SLUG}/organizer/games/${game.slug}/settlement`,
  );
  assertEquals((await getSignup(kv, game.id, player.id))?.payment, "paid");
});

Deno.test("confirming a payment is recorded in the audit trail", async () => {
  const { game, player, organizer, groupId } = await frozenGame();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/payments/confirm`, auth, {
    userId: player.id,
  });
  await response.body?.cancel();

  // Redirecting somewhere other than the game page must not cost the entry.
  // These are the actions where a record of who moved money matters most.
  const entries = await listAudit(kv, groupId);
  const confirmations = entries.filter(
    (entry) =>
      entry.action === "signup.payment_confirmed" &&
      entry.targetId === game.id,
  );

  assertEquals(confirmations.length, 1);
  assertEquals(confirmations[0]?.actorId, organizer.id);
});

Deno.test("recording a refund is written to the audit trail", async () => {
  const { game, player, organizer, groupId } = await frozenGame();
  const auth = await signIn(organizer);

  for (const path of ["payments/confirm", "payments/refund"]) {
    const response = await post(`/games/${game.slug}/${path}`, auth, {
      userId: player.id,
    });
    await response.body?.cancel();
  }

  const entries = await listAudit(kv, groupId);
  const refunds = entries.filter(
    (entry) => entry.action === "signup.refunded" && entry.targetId === game.id,
  );

  assertEquals(refunds.length, 1);
  assertEquals(refunds[0]?.actorId, organizer.id);
  assertEquals((await getSignup(kv, game.id, player.id))?.payment, "refunded");
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
      `http://localhost:8000/g/${DEFAULT_GROUP_SLUG}/organizer/games/${game.slug}/settlement`,
      { headers: { cookie: auth.cookie } },
    ),
  );
  await response.body?.cancel();

  assertEquals(response.status, 403);
});

Deno.test("an organizer cannot reach another club's game by naming their own club", async () => {
  const { game } = await frozenGame();

  // A club of their own, and organizer rights over that one only.
  const outsider = await seedPlayer(kv);
  const theirs = await createGroupForOwner(kv, {
    name: "Other Club",
    slug: `other-club-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: outsider.id,
  });
  const auth = await signIn(outsider);

  for (
    const path of [
      `/g/${theirs.slug}/organizer/games/${game.slug}/settlement`,
      `/g/${theirs.slug}/organizer/games/${game.slug}/edit`,
    ]
  ) {
    const response = await handler(
      new Request(`http://localhost:8000${path}`, {
        headers: { cookie: auth.cookie },
      }),
    );
    await response.body?.cancel();
    // Not theirs to see, so it does not exist as far as they are concerned.
    assertEquals(response.status, 404, path);
  }
});
