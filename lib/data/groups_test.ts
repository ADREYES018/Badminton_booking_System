import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { withTestKv } from "../testing/kv_test_helper.ts";
import { seedPlayer } from "../testing/fixtures.ts";
import { createUser } from "./users.ts";
import {
  addMemberByEmail,
  consumeGroupInvite,
  createGroup,
  createGroupForOwner,
  ensureMembership,
  getMembership,
  InviteError,
  issueGroupInvite,
  listGroupsForUser,
  MembershipError,
  updateGroup,
} from "./groups.ts";
import { keys } from "../kv/keys.ts";
import type { Group, GroupInvite, User } from "../types.ts";

async function seedGroup(
  kv: Deno.Kv,
  owner: User,
  slug = "smash-club",
): Promise<Group> {
  return await createGroupForOwner(kv, {
    name: "Smash Club",
    slug,
    ownerId: owner.id,
  });
}

async function seedOwner(kv: Deno.Kv): Promise<User> {
  return await createUser(kv, {
    email: `owner-${crypto.randomUUID()}@example.com`,
    name: "Owner",
    role: "organizer",
  });
}

Deno.test("a group's creator is seated as its first organizer", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await seedGroup(kv, owner);

    const membership = await getMembership(kv, group.id, owner.id);
    assertEquals(membership?.role, "organizer");
  });
});

Deno.test("listGroupsForUser returns every group joined, and only those", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const player = await seedPlayer(kv);

    const joined = await seedGroup(kv, owner, "joined-club");
    await seedGroup(kv, owner, "other-club");
    await ensureMembership(kv, joined.id, player.id);

    const theirs = await listGroupsForUser(kv, player.id);
    assertEquals(theirs.map((g) => g.slug), ["joined-club"]);

    // The owner is a member of both by virtue of having created them.
    const owned = await listGroupsForUser(kv, owner.id);
    assertEquals(owned.length, 2);
  });
});

Deno.test("a user in no group gets an empty list rather than an error", async () => {
  await withTestKv(async (kv) => {
    const stranger = await seedPlayer(kv);
    assertEquals(await listGroupsForUser(kv, stranger.id), []);
  });
});

Deno.test("a membership pointing at a deleted group is skipped, not fatal", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const player = await seedPlayer(kv);
    const alive = await seedGroup(kv, owner, "alive-club");
    const doomed = await seedGroup(kv, owner, "doomed-club");

    await ensureMembership(kv, alive.id, player.id);
    await ensureMembership(kv, doomed.id, player.id);
    await kv.delete(keys.group(doomed.id));

    const theirs = await listGroupsForUser(kv, player.id);
    assertEquals(theirs.map((g) => g.slug), ["alive-club"]);
  });
});

Deno.test("updateGroup changes only the fields it is given", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await seedGroup(kv, owner);

    const renamed = await updateGroup(kv, group.id, { name: "Smash Club DXB" });
    assertEquals(renamed.name, "Smash Club DXB");
    assertEquals(renamed.defaultCutoffHours, group.defaultCutoffHours);
    assertEquals(renamed.ownerId, group.ownerId);
  });
});

Deno.test("clearing a group's description removes it rather than storing null", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await createGroup(kv, {
      name: "Smash Club",
      slug: "smash-club",
      ownerId: owner.id,
      description: "Badminton sessions in Dubai.",
    });

    const cleared = await updateGroup(kv, group.id, { description: null });
    assertEquals(cleared.description, undefined);
  });
});

Deno.test("an invite admits its redeemer as a player", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const player = await seedPlayer(kv);
    const group = await seedGroup(kv, owner);

    const { token } = await issueGroupInvite(kv, group.id, owner.id);
    const joined = await consumeGroupInvite(kv, token, player.id);

    assertEquals(joined.id, group.id);
    const membership = await getMembership(kv, group.id, player.id);
    assertEquals(membership?.role, "player");
  });
});

Deno.test("an invite is stored hashed, so the database never holds a usable link", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await seedGroup(kv, owner);
    const { token } = await issueGroupInvite(kv, group.id, owner.id);

    const rows = await Array.fromAsync(
      kv.list<GroupInvite>({ prefix: ["group_invite"] }),
    );
    assertEquals(rows.length, 1);
    // The key is a hash: the raw token appears nowhere in the stored row.
    assertEquals(rows[0]?.key.includes(token), false);
    assertEquals(JSON.stringify(rows[0]?.value).includes(token), false);
  });
});

Deno.test("an invite is single use", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const first = await seedPlayer(kv, 1);
    const second = await seedPlayer(kv, 2);
    const group = await seedGroup(kv, owner);

    const { token } = await issueGroupInvite(kv, group.id, owner.id);
    await consumeGroupInvite(kv, token, first.id);

    await assertRejects(
      () => consumeGroupInvite(kv, token, second.id),
      InviteError,
      "already been used",
    );
    assertEquals(await getMembership(kv, group.id, second.id), null);
  });
});

Deno.test("redeeming twice is harmless for someone already a member", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const player = await seedPlayer(kv);
    const group = await seedGroup(kv, owner);

    const { token } = await issueGroupInvite(kv, group.id, owner.id);
    await consumeGroupInvite(kv, token, player.id);
    const again = await consumeGroupInvite(kv, token, player.id);

    assertEquals(again.id, group.id);
  });
});

Deno.test("an invite never grants organizer rights, even to a platform organizer", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const otherOrganizer = await createUser(kv, {
      email: `other-${crypto.randomUUID()}@example.com`,
      name: "Other Organizer",
      role: "organizer",
    });
    const group = await seedGroup(kv, owner);

    const { token } = await issueGroupInvite(kv, group.id, owner.id);
    await consumeGroupInvite(kv, token, otherOrganizer.id);

    const membership = await getMembership(kv, group.id, otherOrganizer.id);
    assertEquals(membership?.role, "player");
  });
});

Deno.test("an unknown invite token is refused", async () => {
  await withTestKv(async (kv) => {
    const player = await seedPlayer(kv);
    await assertRejects(
      () => consumeGroupInvite(kv, "not-a-real-token", player.id),
      InviteError,
      "not valid",
    );
  });
});

Deno.test("an invite whose group has been deleted is refused", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const player = await seedPlayer(kv);
    const group = await seedGroup(kv, owner);

    const { token } = await issueGroupInvite(kv, group.id, owner.id);
    await kv.delete(keys.group(group.id));

    await assertRejects(
      () => consumeGroupInvite(kv, token, player.id),
      InviteError,
      "no longer exists",
    );
  });
});

Deno.test("an organizer can add an existing account by email", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await seedGroup(kv, owner);
    const player = await createUser(kv, {
      email: "newcomer@example.com",
      name: "Newcomer",
    });

    const membership = await addMemberByEmail(
      kv,
      group.id,
      "  NEWCOMER@Example.com  ",
    );
    assertEquals(membership.userId, player.id);
    assertExists(await getMembership(kv, group.id, player.id));
  });
});

Deno.test("adding an email with no account is refused rather than pre-creating one", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await seedGroup(kv, owner);

    await assertRejects(
      () => addMemberByEmail(kv, group.id, "nobody@example.com"),
      MembershipError,
      "invite link",
    );
  });
});

Deno.test("adding someone already in the group leaves their role untouched", async () => {
  await withTestKv(async (kv) => {
    const owner = await seedOwner(kv);
    const group = await seedGroup(kv, owner);

    const readded = await addMemberByEmail(kv, group.id, owner.email);
    assertEquals(readded.role, "organizer");
  });
});
