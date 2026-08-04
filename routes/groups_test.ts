/**
 * Route-level tests for clubs: the list, creating one, invite redemption, and
 * what a club's games page shows someone who is not in it.
 *
 * These drive the real `app.handler()`, so they cover what the data-layer tests
 * cannot: the redirect contract for the bare paths, CSRF, and the difference
 * between what a member and a stranger are shown on the same URL.
 *
 * The app resolves KV through the `getKv()` singleton, so the environment is
 * pointed at an in-memory database before `main.ts` is imported.
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
const { futureStart, seedGame } = await import("../lib/testing/fixtures.ts");
const {
  createGroupForOwner,
  DEFAULT_GROUP_SLUG,
  ensureMembership,
  getMembership,
  issueGroupInvite,
  listGroupsForUser,
  setMemberBlocked,
} = await import("../lib/data/groups.ts");
const { createGame } = await import("../lib/data/games.ts");
const { getSignup } = await import("../lib/data/signups.ts");
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

function get(path: string, auth?: { cookie: string }) {
  return handler(
    new Request(`http://localhost:8000${path}`, {
      headers: auth ? { cookie: auth.cookie } : {},
    }),
  );
}

function post(
  path: string,
  auth: { cookie: string; csrf: string },
  fields: Record<string, string> = {},
  options: { csrf?: string } = {},
) {
  const body = new FormData();
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

/** A player who can be put on a roster: name and phone both present. */
async function seedComplete(label: string): Promise<User> {
  const user = await createUser(kv, {
    email: `${label}-${crypto.randomUUID()}@example.com`,
    name: `Player ${label}`,
  });
  return await updateUser(kv, user.id, {
    phone: `+9715${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
  });
}

function locationOf(response: Response): string {
  return response.headers.get("location") ?? "";
}

Deno.test("a player in no club still lands on games to join", async () => {
  // Belonging to a club is not a precondition for playing, so the first screen
  // is a list of games rather than a request to be let in somewhere.
  const { game } = await seedGame(kv);
  const stranger = await seedComplete("stranger");

  const response = await get("/games", await signIn(stranger));
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, game.title);
});

Deno.test("the games list spans every club, not just one", async () => {
  const first = await seedGame(kv);
  const owner = await seedComplete("other-owner");
  const otherGroup = await createGroupForOwner(kv, {
    name: "Other Club",
    slug: `other-club-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  });
  const second = await createGame(kv, {
    groupId: otherGroup.id,
    title: "Elsewhere Session",
    venue: { name: "Other Courts", address: "Dubai" },
    startUtc: futureStart(120),
    endUtc: futureStart(122),
    courts: 1,
    playersPerCourt: 4,
    pricePerPlayerFils: 3000,
    cutoffHours: 48,
    createdBy: owner.id,
  });

  const player = await seedComplete("browsing");
  const response = await get("/games", await signIn(player));
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, first.game.title);
  assertStringIncludes(body, second.title);
});

Deno.test("the games list offers an organizer their own new-game form", async () => {
  const { organizer, groupId } = await seedGame(kv);
  const withPhone = await updateUser(kv, organizer.id, {
    phone: "+971500000009",
  });
  const group = (await listGroupsForUser(kv, organizer.id))
    .find((g) => g.id === groupId);

  const response = await get("/games", await signIn(withPhone));
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, `/g/${group!.slug}/organizer/games/new`);
});

Deno.test("someone organizing nothing is pointed at making a club first", async () => {
  // Posting a game needs a club to post it into, and making one is the step
  // that turns a player into an organizer.
  const player = await seedComplete("no-club");

  const response = await get("/games", await signIn(player));
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, 'href="/groups"');
});

Deno.test("creating a club seats the creator as its organizer", async () => {
  const founder = await seedComplete("founder");
  const auth = await signIn(founder);

  const response = await post("/groups", auth, {
    name: "Dubai Smashers",
    description: "Tuesdays at Al Quoz",
  });
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertStringIncludes(locationOf(response), "/g/dubai-smashers/games");

  const groups = await listGroupsForUser(kv, founder.id);
  const created = groups.find((g) => g.slug === "dubai-smashers");
  assertEquals(created?.name, "Dubai Smashers");
  assertEquals(
    (await getMembership(kv, created!.id, founder.id))?.role,
    "organizer",
  );
});

Deno.test("a club name that is already taken is refused", async () => {
  const first = await seedComplete("taken-first");
  const second = await seedComplete("taken-second");

  const made = await post("/groups", await signIn(first), {
    name: "Duplicate Club",
  });
  await made.body?.cancel();

  const clash = await post("/groups", await signIn(second), {
    name: "Duplicate Club",
  });
  const body = await clash.text();

  assertEquals(clash.status, 200);
  assertStringIncludes(body, "already uses that name");
});

Deno.test("a club form without a valid CSRF token is refused", async () => {
  const founder = await seedComplete("csrf");
  const auth = await signIn(founder);

  const response = await post("/groups", auth, { name: "Forged Club" }, {
    csrf: "not-the-real-token",
  });
  await response.body?.cancel();

  assertEquals(response.status, 403);
});

Deno.test("an invite link admits its recipient and lands them in the club", async () => {
  const owner = await seedComplete("invite-owner");
  const newcomer = await seedComplete("invite-newcomer");
  const group = await createGroupForOwner(kv, {
    name: "Invite Club",
    slug: `invite-club-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  });

  const { token } = await issueGroupInvite(kv, group.id, owner.id);
  const response = await get(`/invite/${token}`, await signIn(newcomer));
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertStringIncludes(locationOf(response), `/g/${group.slug}/games`);
  assertEquals(
    (await getMembership(kv, group.id, newcomer.id))?.role,
    "player",
  );
});

Deno.test("a spent invite link explains itself rather than 500ing", async () => {
  const owner = await seedComplete("spent-owner");
  const first = await seedComplete("spent-first");
  const second = await seedComplete("spent-second");
  const group = await createGroupForOwner(kv, {
    name: "Spent Club",
    slug: `spent-club-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  });

  const { token } = await issueGroupInvite(kv, group.id, owner.id);
  const used = await get(`/invite/${token}`, await signIn(first));
  await used.body?.cancel();

  const response = await get(`/invite/${token}`, await signIn(second));
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertStringIncludes(locationOf(response), "/groups?error=");
  assertStringIncludes(
    decodeURIComponent(locationOf(response)),
    "already been used",
  );
  assertEquals(await getMembership(kv, group.id, second.id), null);
});

Deno.test("an invite link needs a signed-in reader", async () => {
  const response = await get("/invite/some-token");
  await response.body?.cancel();
  // Unauthenticated requests are bounced to sign-in, not shown the club.
  assertEquals(response.status, 303);
  assertStringIncludes(locationOf(response), "/auth/login");
});

Deno.test("a club's games page names the club and lists its games", async () => {
  const { game, organizer } = await seedGame(kv);
  const complete = await updateUser(kv, organizer.id, {
    phone: "+971500000002",
  });

  const response = await get(
    `/g/${DEFAULT_GROUP_SLUG}/games`,
    await signIn(complete),
  );
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, "Smash Club");
  assertStringIncludes(body, game.title);
});

Deno.test("a stranger sees a club's games with nothing in their way", async () => {
  const { game } = await seedGame(kv);
  const stranger = await seedComplete("outsider");

  const response = await get(
    `/g/${DEFAULT_GROUP_SLUG}/games`,
    await signIn(stranger),
  );
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, game.title);
  // Membership no longer gates playing, so nothing here asks them to join.
  assertEquals(body.includes("Request to join"), false);
});

Deno.test("an unknown club slug is a 404", async () => {
  const player = await seedComplete("lost");
  const response = await get("/g/no-such-club/games", await signIn(player));
  await response.body?.cancel();
  assertEquals(response.status, 404);
});

Deno.test("a club's stats and check-in are open to anyone signed in", async () => {
  // Check-in shows a player their own permanent code, and stats are a
  // leaderboard — neither is private to a club now that anyone may play.
  const { organizer } = await seedGame(kv);
  const member = await updateUser(kv, organizer.id, {
    phone: "+971500000003",
  });
  const stranger = await seedComplete("nosy");

  for (const page of ["stats", "checkin"]) {
    const path = `/g/${DEFAULT_GROUP_SLUG}/${page}`;

    for (const user of [member, stranger]) {
      const response = await get(path, await signIn(user));
      await response.body?.cancel();
      assertEquals(response.status, 200, `${page} should render`);
    }
  }
});

Deno.test("the bare stats and check-in paths follow a lone club through", async () => {
  const player = await seedComplete("bare-paths");
  const owner = await seedComplete("bare-owner");
  const group = await createGroupForOwner(kv, {
    name: "Bare Club",
    slug: `bare-club-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  });
  await ensureMembership(kv, group.id, player.id);
  const auth = await signIn(player);

  for (const page of ["stats", "checkin"] as const) {
    const response = await get(`/${page}`, auth);
    await response.body?.cancel();
    assertEquals(response.status, 302);
    assertEquals(locationOf(response), `/g/${group.slug}/${page}`);
  }
});

Deno.test("a non-member may take a seat in a public game", async () => {
  const { game } = await seedGame(kv);
  const stranger = await seedComplete("gatecrasher");
  const auth = await signIn(stranger);

  const page = await get(`/games/${game.slug}`, auth);
  await page.body?.cancel();
  assertEquals(page.status, 200);

  const attempt = await post(`/games/${game.slug}/join`, auth);
  await attempt.body?.cancel();
  assertEquals(attempt.status, 303);
  assertEquals(
    (await getSignup(kv, game.id, stranger.id))?.status,
    "confirmed",
  );
});

Deno.test("a password game refuses a seat until the code is entered", async () => {
  const { groupId, organizer } = await seedGame(kv);
  const locked = await createGame(kv, {
    groupId,
    title: "Invite Only Session",
    venue: { name: "Test Courts", address: "Dubai" },
    startUtc: futureStart(120),
    endUtc: futureStart(122),
    courts: 1,
    playersPerCourt: 4,
    pricePerPlayerFils: 3000,
    cutoffHours: 48,
    createdBy: organizer.id,
    visibility: "password",
  });

  const player = await seedComplete("codeless");
  const auth = await signIn(player);

  // The page is readable, and it is listed — only the seat is gated.
  const page = await get(`/games/${locked.slug}`, auth);
  const body = await page.text();
  assertEquals(page.status, 200);
  assertStringIncludes(body, "This game needs a code");

  const refused = await post(`/games/${locked.slug}/join`, auth);
  await refused.body?.cancel();
  assertEquals(refused.status, 403);
  assertEquals(await getSignup(kv, locked.id, player.id), null);

  // A wrong code changes nothing.
  const wrong = await post(`/games/${locked.slug}/unlock`, auth, {
    joinCode: "000000" === locked.joinCode ? "111111" : "000000",
  });
  await wrong.body?.cancel();
  const stillRefused = await post(`/games/${locked.slug}/join`, auth);
  await stillRefused.body?.cancel();
  assertEquals(stillRefused.status, 403);

  // The real code lets them in, and keeps letting them in.
  const unlock = await post(`/games/${locked.slug}/unlock`, auth, {
    joinCode: locked.joinCode!,
  });
  await unlock.body?.cancel();

  const joined = await post(`/games/${locked.slug}/join`, auth);
  await joined.body?.cancel();
  assertEquals(joined.status, 303);
  assertEquals(
    (await getSignup(kv, locked.id, player.id))?.status,
    "confirmed",
  );
});

Deno.test("an unlisted game is invisible to a non-member", async () => {
  const { groupId, organizer } = await seedGame(kv);
  const hidden = await createGame(kv, {
    groupId,
    title: "Quiet Session",
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

  // Kept out of the listing: the URL is the whole access control.
  const stranger = await seedComplete("prying");
  const listing = await get("/games", await signIn(stranger));
  const body = await listing.text();
  assertEquals(body.includes(hidden.title), false);

  // But anyone the organizer hands the link to can open it and join.
  const invited = await seedComplete("invited");
  const auth = await signIn(invited);
  const allowed = await get(`/games/${hidden.slug}`, auth);
  await allowed.body?.cancel();
  assertEquals(allowed.status, 200);

  const joined = await post(`/games/${hidden.slug}/join`, auth);
  await joined.body?.cancel();
  assertEquals(
    (await getSignup(kv, hidden.id, invited.id))?.status,
    "confirmed",
  );
});

Deno.test("a blocked member cannot join a game", async () => {
  const { game, groupId } = await seedGame(kv);
  const player = await seedComplete("blocked");
  await ensureMembership(kv, groupId, player.id);
  await setMemberBlocked(kv, groupId, player.id, true, {
    actorId: player.id,
    reason: "Repeated no-shows",
  });

  const response = await post(`/games/${game.slug}/join`, await signIn(player));
  await response.body?.cancel();

  assertEquals(response.status, 403);
  assertEquals(await getSignup(kv, game.id, player.id), null);
});

Deno.test("a club page keeps its navigation inside that club", async () => {
  const { organizer } = await seedGame(kv);
  const member = await updateUser(kv, organizer.id, {
    phone: "+971500000004",
  });

  const response = await get(
    `/g/${DEFAULT_GROUP_SLUG}/games`,
    await signIn(member),
  );
  const body = await response.text();

  // Tapping "Stats" from a club's games page must not bounce through a
  // redirect that could land on a different club.
  assertStringIncludes(body, `href="/g/${DEFAULT_GROUP_SLUG}/stats"`);
  assertStringIncludes(body, `href="/g/${DEFAULT_GROUP_SLUG}/checkin"`);
  // Profile is not a club page, so it keeps its single address.
  assertStringIncludes(body, 'href="/profile"');
});
