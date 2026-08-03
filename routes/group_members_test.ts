/**
 * Route-level tests for the members and settings screens.
 *
 * These cover what the data-layer tests cannot: who may reach the pages at
 * all, that the owner's rights cannot be taken away through the UI, and that
 * an organizer's decision on a join request actually seats the applicant.
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
const {
  createGroupForOwner,
  ensureMembership,
  getGroup,
  getJoinRequest,
  getMembership,
  requestToJoin,
} = await import("../lib/data/groups.ts");
const { createUser } = await import("../lib/data/users.ts");
type Group = import("../lib/types.ts").Group;
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

function get(path: string, auth: { cookie: string }) {
  return handler(
    new Request(`http://localhost:8000${path}`, {
      headers: { cookie: auth.cookie },
    }),
  );
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

async function seedUser(label: string): Promise<User> {
  return await createUser(kv, {
    email: `${label}-${crypto.randomUUID()}@example.com`,
    name: `Player ${label}`,
  });
}

/** A club with an owner, plus a plain member. */
async function seedClub(label: string): Promise<{
  group: Group;
  owner: User;
  member: User;
}> {
  const owner = await seedUser(`${label}-owner`);
  const member = await seedUser(`${label}-member`);
  const group = await createGroupForOwner(kv, {
    name: `${label} Club`,
    slug: `${label}-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  });
  await ensureMembership(kv, group.id, member.id);
  return { group, owner, member };
}

Deno.test("the members page is for organizers only", async () => {
  const { group, owner, member } = await seedClub("roster");

  const allowed = await get(
    `/g/${group.slug}/members`,
    await signIn(owner),
  );
  const body = await allowed.text();
  assertEquals(allowed.status, 200);
  assertStringIncludes(body, "On the roster");

  const refused = await get(`/g/${group.slug}/members`, await signIn(member));
  await refused.body?.cancel();
  assertEquals(refused.status, 403);
});

Deno.test("an organizer can promote and demote a member", async () => {
  const { group, owner, member } = await seedClub("promote");
  const auth = await signIn(owner);

  const promoted = await post(
    `/g/${group.slug}/members/${member.id}/role`,
    auth,
    { role: "organizer" },
  );
  await promoted.body?.cancel();
  assertEquals(
    (await getMembership(kv, group.id, member.id))?.role,
    "organizer",
  );

  const demoted = await post(
    `/g/${group.slug}/members/${member.id}/role`,
    auth,
    { role: "player" },
  );
  await demoted.body?.cancel();
  assertEquals((await getMembership(kv, group.id, member.id))?.role, "player");
});

Deno.test("the club's owner cannot be demoted or blocked", async () => {
  const { group, owner, member } = await seedClub("owner-safe");
  // Even by another organizer, so no club can be left unadministered.
  await post(
    `/g/${group.slug}/members/${member.id}/role`,
    await signIn(owner),
    {
      role: "organizer",
    },
  ).then((r) => r.body?.cancel());
  const auth = await signIn(member);

  for (const path of ["role", "block"]) {
    const response = await post(
      `/g/${group.slug}/members/${owner.id}/${path}`,
      auth,
      path === "role" ? { role: "player" } : { blocked: "true" },
    );
    await response.body?.cancel();
    assertEquals(response.status, 403, path);
  }

  const still = await getMembership(kv, group.id, owner.id);
  assertEquals(still?.role, "organizer");
  assertEquals(still?.blocked, false);
});

Deno.test("blocking and unblocking a member both take effect", async () => {
  const { group, owner, member } = await seedClub("block");
  const auth = await signIn(owner);

  await post(`/g/${group.slug}/members/${member.id}/block`, auth, {
    blocked: "true",
    reason: "Repeated no-shows",
  }).then((r) => r.body?.cancel());
  const blocked = await getMembership(kv, group.id, member.id);
  assertEquals(blocked?.blocked, true);
  assertEquals(blocked?.blockReason, "Repeated no-shows");

  await post(`/g/${group.slug}/members/${member.id}/block`, auth, {
    blocked: "false",
  }).then((r) => r.body?.cancel());
  assertEquals(
    (await getMembership(kv, group.id, member.id))?.blocked,
    false,
  );
});

Deno.test("an invite link is minted and shown back to the organizer", async () => {
  const { group, owner } = await seedClub("mint");

  const response = await post(`/g/${group.slug}/invite`, await signIn(owner));
  await response.body?.cancel();

  assertEquals(response.status, 303);
  const location = response.headers.get("location") ?? "";
  const invite = new URL(location, "http://localhost:8000").searchParams
    .get("invite");
  assertStringIncludes(invite ?? "", "http://localhost:8000/invite/");
});

Deno.test("adding an unknown email is refused with a readable reason", async () => {
  const { group, owner } = await seedClub("unknown-email");

  const response = await post(
    `/g/${group.slug}/members`,
    await signIn(owner),
    { email: "nobody@example.com" },
  );
  await response.body?.cancel();

  const location = response.headers.get("location") ?? "";
  const error = new URL(location, "http://localhost:8000").searchParams
    .get("error");
  assertStringIncludes(error ?? "", "invite link");
});

Deno.test("a player asks to join and an organizer approves", async () => {
  const { group, owner } = await seedClub("asking");
  const applicant = await seedUser("applicant");

  const asked = await get(`/g/${group.slug}/request`, await signIn(applicant));
  await asked.body?.cancel();
  assertEquals(asked.status, 302);
  assertEquals(
    (await getJoinRequest(kv, group.id, applicant.id))?.status,
    "pending",
  );

  // The organizer sees them waiting.
  const page = await get(`/g/${group.slug}/members`, await signIn(owner));
  const body = await page.text();
  assertStringIncludes(body, "Asked to join");

  const approved = await post(
    `/g/${group.slug}/requests/${applicant.id}`,
    await signIn(owner),
    { decision: "approved" },
  );
  await approved.body?.cancel();

  assertEquals(
    (await getMembership(kv, group.id, applicant.id))?.role,
    "player",
  );
});

Deno.test("a declined request leaves the applicant outside the club", async () => {
  const { group, owner } = await seedClub("declining");
  const applicant = await seedUser("declined");
  await requestToJoin(kv, group.id, applicant.id);

  const response = await post(
    `/g/${group.slug}/requests/${applicant.id}`,
    await signIn(owner),
    { decision: "rejected" },
  );
  await response.body?.cancel();

  assertEquals(await getMembership(kv, group.id, applicant.id), null);
  assertEquals(
    (await getJoinRequest(kv, group.id, applicant.id))?.status,
    "rejected",
  );
});

Deno.test("only an organizer decides a join request", async () => {
  const { group, member } = await seedClub("not-yours");
  const applicant = await seedUser("hopeful");
  await requestToJoin(kv, group.id, applicant.id);

  const response = await post(
    `/g/${group.slug}/requests/${applicant.id}`,
    await signIn(member),
    { decision: "approved" },
  );
  await response.body?.cancel();

  assertEquals(response.status, 403);
  assertEquals(await getMembership(kv, group.id, applicant.id), null);
});

Deno.test("settings save the name, the cutoff and the payout details", async () => {
  const { group, owner } = await seedClub("settings");

  const response = await post(
    `/g/${group.slug}/settings`,
    await signIn(owner),
    {
      name: "Renamed Club",
      description: "Now on Thursdays",
      cutoffHours: "24",
      bank: "Emirates NBD",
      accountName: "Renamed Club",
      iban: "AE070331234567890123456",
    },
  );
  await response.body?.cancel();

  const saved = await getGroup(kv, group.id);
  assertEquals(saved?.name, "Renamed Club");
  assertEquals(saved?.defaultCutoffHours, 24);
  assertEquals(saved?.payout?.bank, "Emirates NBD");
  assertEquals(saved?.payout?.iban, "AE070331234567890123456");
  // The address does not move when the club is renamed.
  assertEquals(saved?.slug, group.slug);
});

Deno.test("half-entered payment details are refused", async () => {
  const { group, owner } = await seedClub("half-payout");

  const response = await post(
    `/g/${group.slug}/settings`,
    await signIn(owner),
    {
      name: "Half Club",
      cutoffHours: "48",
      accountName: "Half Club",
    },
  );
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, "the bank, the account name and the IBAN");
  assertEquals((await getGroup(kv, group.id))?.payout, undefined);
});

Deno.test("an invalid IBAN is refused before anything is saved", async () => {
  const { group, owner } = await seedClub("bad-iban");

  const response = await post(
    `/g/${group.slug}/settings`,
    await signIn(owner),
    {
      name: "Should Not Save",
      cutoffHours: "48",
      bank: "Emirates NBD",
      accountName: "Test",
      iban: "AE00NOTANIBAN",
    },
  );
  const body = await response.text();

  assertStringIncludes(body, "valid IBAN");
  assertEquals((await getGroup(kv, group.id))?.name, "bad-iban Club");
});

Deno.test("settings are for organizers only", async () => {
  const { group, member } = await seedClub("settings-guard");
  const response = await get(`/g/${group.slug}/settings`, await signIn(member));
  await response.body?.cancel();
  assertEquals(response.status, 403);
});
