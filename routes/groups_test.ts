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
const { seedGame } = await import("../lib/testing/fixtures.ts");
const {
  createGroupForOwner,
  DEFAULT_GROUP_SLUG,
  ensureMembership,
  getMembership,
  issueGroupInvite,
  listGroupsForUser,
} = await import("../lib/data/groups.ts");
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

Deno.test("a user in no club is sent to the club list", async () => {
  const stranger = await seedComplete("stranger");
  const auth = await signIn(stranger);

  const response = await get("/games", auth);
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertEquals(locationOf(response), "/groups");
});

Deno.test("a user in exactly one club is taken straight there", async () => {
  const player = await seedComplete("only-one");
  const owner = await seedComplete("owner-one");
  const group = await createGroupForOwner(kv, {
    name: "Only Club",
    slug: `only-club-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  });
  await ensureMembership(kv, group.id, player.id);
  const auth = await signIn(player);

  const response = await get("/games", auth);
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertEquals(locationOf(response), `/g/${group.slug}/games`);
});

Deno.test("a user in several clubs is asked which one", async () => {
  const player = await seedComplete("several");
  const owner = await seedComplete("owner-several");
  for (const name of ["first", "second"]) {
    const group = await createGroupForOwner(kv, {
      name,
      slug: `${name}-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: owner.id,
    });
    await ensureMembership(kv, group.id, player.id);
  }
  const auth = await signIn(player);

  const response = await get("/games", auth);
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertEquals(locationOf(response), "/groups");
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

Deno.test("a stranger sees the club's games but is offered the way in, not a roster", async () => {
  const { game } = await seedGame(kv);
  const stranger = await seedComplete("outsider");

  const response = await get(
    `/g/${DEFAULT_GROUP_SLUG}/games`,
    await signIn(stranger),
  );
  const body = await response.text();

  assertEquals(response.status, 200);
  // The games are visible: a club is private in who may play, not in whether
  // it exists.
  assertStringIncludes(body, game.title);
  assertStringIncludes(body, "Request to join");
});

Deno.test("an unknown club slug is a 404", async () => {
  const player = await seedComplete("lost");
  const response = await get("/g/no-such-club/games", await signIn(player));
  await response.body?.cancel();
  assertEquals(response.status, 404);
});

Deno.test("a club's stats and check-in are for its members", async () => {
  const { organizer } = await seedGame(kv);
  const member = await updateUser(kv, organizer.id, {
    phone: "+971500000003",
  });
  const stranger = await seedComplete("nosy");

  for (const page of ["stats", "checkin"]) {
    const path = `/g/${DEFAULT_GROUP_SLUG}/${page}`;

    const allowed = await get(path, await signIn(member));
    await allowed.body?.cancel();
    assertEquals(allowed.status, 200, `member should see ${page}`);

    const refused = await get(path, await signIn(stranger));
    await refused.body?.cancel();
    assertEquals(refused.status, 403, `stranger should not see ${page}`);
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
