/**
 * Groups, membership, and the invites that grant it.
 *
 * A user belongs to a group only by an explicit act: they created it, an
 * organizer added them, or they redeemed an invite link. Nothing joins anyone
 * automatically — a page view is not consent to appear on a club's roster.
 *
 * `ensureDefaultGroup` survives for the demo seeder and the test fixtures,
 * which want one deterministic club without going through the UI. It is
 * idempotent and safe to call concurrently: the slug index is reserved inside
 * the same atomic commit that writes the record, the same way `createUser`
 * reserves an email.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import { getRecord, listRecords, withRetry } from "../kv/kv.ts";
import type {
  Group,
  GroupInvite,
  GroupRole,
  JoinRequest,
  Membership,
  PayoutDetails,
} from "../types.ts";
import { nowIso } from "../domain/time.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { getUserByEmail } from "./users.ts";

/** Slug of the club the demo seeder and the test fixtures use. */
export const DEFAULT_GROUP_SLUG = "smash-club";

/**
 * How long an invite link stays usable.
 *
 * Long enough to be shared and acted on over a weekend, short enough that a
 * link pasted into a group chat and forgotten does not stay a way in forever.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Matches the spec's cancellation window; overridable per game. */
export const DEFAULT_CUTOFF_HOURS = 48;

export async function getGroup(
  kv: Deno.Kv,
  groupId: string,
): Promise<Group | null> {
  const entry = await getRecord<Group>(kv, keys.group(groupId));
  return entry.value;
}

export async function getGroupBySlug(
  kv: Deno.Kv,
  slug: string,
): Promise<Group | null> {
  const pointer = await kv.get<string>(keys.groupBySlug(slug));
  if (!pointer.value) return null;
  return await getGroup(kv, pointer.value);
}

export interface CreateGroupInput {
  name: string;
  slug: string;
  ownerId: string;
  description?: string;
  cutoffHours?: number;
}

/**
 * Creates a group and reserves its slug in one commit.
 * Returns the existing group if the slug was already taken, so a racing caller
 * gets the winner's record rather than an error.
 */
export async function createGroup(
  kv: Deno.Kv,
  input: CreateGroupInput,
): Promise<Group> {
  const now = nowIso();
  const group: Group = {
    v: 1,
    id: ulid(),
    slug: input.slug,
    name: input.name,
    description: input.description,
    ownerId: input.ownerId,
    defaultCutoffHours: input.cutoffHours ?? DEFAULT_CUTOFF_HOURS,
    createdAt: now,
    updatedAt: now,
  };

  const result = await kv.atomic()
    .check({ key: keys.groupBySlug(group.slug), versionstamp: null })
    .set(keys.group(group.id), group)
    .set(keys.groupBySlug(group.slug), group.id)
    .commit();

  if (!result.ok) {
    const existing = await getGroupBySlug(kv, input.slug);
    if (existing) return existing;
    throw new Error(`Could not create group ${input.slug}`);
  }

  return group;
}

/**
 * Returns the club, creating it on first call.
 *
 * `ownerId` seeds ownership when the group does not exist yet — normally the
 * first user to touch the system. An existing group's owner is never changed.
 */
export async function ensureDefaultGroup(
  kv: Deno.Kv,
  ownerId: string,
): Promise<Group> {
  const existing = await getGroupBySlug(kv, DEFAULT_GROUP_SLUG);
  if (existing) return existing;

  return await createGroup(kv, {
    name: "Smash Club",
    slug: DEFAULT_GROUP_SLUG,
    ownerId,
    description: "Badminton sessions in Dubai.",
  });
}

export interface UpdateGroupInput {
  name?: string;
  description?: string | null;
  defaultCutoffHours?: number;
}

export async function updateGroup(
  kv: Deno.Kv,
  groupId: string,
  update: UpdateGroupInput,
): Promise<Group> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Group>(kv, keys.group(groupId));
    if (!entry.value) throw new Error(`Group ${groupId} not found`);

    const next: Group = { ...entry.value, updatedAt: nowIso() };
    if (update.name !== undefined) next.name = update.name;
    if (update.description !== undefined) {
      next.description = update.description ?? undefined;
    }
    if (update.defaultCutoffHours !== undefined) {
      next.defaultCutoffHours = update.defaultCutoffHours;
    }

    return {
      op: kv.atomic().check(entry).set(keys.group(groupId), next),
      result: next,
    };
  });
  if (!result) throw new Error("Group update did not apply");
  return result;
}

/**
 * Creates a group and seats its creator as the first organizer.
 *
 * The membership is a second commit rather than part of the group's own atomic
 * write: it is not required for the slug reservation to be correct, and a
 * membership row without its group would be the worse failure of the two.
 */
export async function createGroupForOwner(
  kv: Deno.Kv,
  input: CreateGroupInput,
): Promise<Group> {
  const group = await createGroup(kv, input);
  await ensureMembership(kv, group.id, input.ownerId, "organizer");
  return group;
}

/**
 * Every group a user belongs to.
 *
 * Reads the `membersByUser` index, which stores a pointer per membership. A
 * pointer whose group has vanished is skipped rather than throwing — an index
 * entry outliving its record is a repairable inconsistency, not a reason to
 * fail someone's group list.
 */
export async function listGroupsForUser(
  kv: Deno.Kv,
  userId: string,
  limit = 50,
): Promise<Group[]> {
  const pointers = await listRecords<string>(
    kv,
    { prefix: ["members_by_user", userId] },
    { limit },
  );

  const groups = await Promise.all(
    pointers.map((pointer) => getGroup(kv, pointer.value)),
  );
  return groups.filter((group): group is Group => group !== null);
}

/**
 * The clubs this user may post a game into.
 *
 * Owning a club and holding the organizer role in one are both enough, and
 * they are not the same thing — an owner is seated as an organizer when the
 * club is created, but a second organizer is only ever the role. Membership
 * alone is not, which is the one distinction that still matters now that
 * playing needs no membership at all.
 */
export async function listGroupsOrganizedBy(
  kv: Deno.Kv,
  userId: string,
  limit = 50,
): Promise<Group[]> {
  const groups = await listGroupsForUser(kv, userId, limit);

  const organized = await Promise.all(
    groups.map(async (group) => {
      if (group.ownerId === userId) return group;
      const membership = await getMembership(kv, group.id, userId);
      return membership?.role === "organizer" ? group : null;
    }),
  );

  return organized.filter((group): group is Group => group !== null);
}

export async function getMembership(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
): Promise<Membership | null> {
  const entry = await getRecord<Membership>(kv, keys.member(groupId, userId));
  return entry.value;
}

/**
 * Joins a user to a group if they are not already a member.
 *
 * Idempotent: an existing membership is returned untouched, so a blocked
 * member is never silently un-blocked by a second call, and a re-join never
 * resets someone's role back to player.
 */
export async function ensureMembership(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
  role: GroupRole = "player",
): Promise<Membership> {
  const existing = await getMembership(kv, groupId, userId);
  if (existing) return existing;

  const membership: Membership = {
    v: 1,
    groupId,
    userId,
    role,
    blocked: false,
    joinedAt: nowIso(),
  };

  const result = await kv.atomic()
    .check({ key: keys.member(groupId, userId), versionstamp: null })
    .set(keys.member(groupId, userId), membership)
    .set(keys.membersByUser(userId, groupId), groupId)
    .commit();

  if (!result.ok) {
    // Another request joined the same user first; theirs is authoritative.
    const raced = await getMembership(kv, groupId, userId);
    if (raced) return raced;
    throw new Error(`Could not add ${userId} to group ${groupId}`);
  }

  return membership;
}

export async function setMemberRole(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
  role: GroupRole,
): Promise<Membership> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Membership>(kv, keys.member(groupId, userId));
    if (!entry.value) throw new Error(`${userId} is not a member`);
    const next: Membership = { ...entry.value, role };
    return {
      op: kv.atomic().check(entry).set(keys.member(groupId, userId), next),
      result: next,
    };
  });
  if (!result) throw new Error("Role change did not apply");
  return result;
}

export interface BlockInput {
  reason?: string;
  actorId: string;
}

export async function setMemberBlocked(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
  blocked: boolean,
  input: BlockInput,
): Promise<Membership> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Membership>(kv, keys.member(groupId, userId));
    if (!entry.value) throw new Error(`${userId} is not a member`);

    const next: Membership = blocked
      ? {
        ...entry.value,
        blocked: true,
        blockReason: input.reason,
        blockedAt: nowIso(),
        blockedBy: input.actorId,
      }
      : {
        ...entry.value,
        blocked: false,
        blockReason: undefined,
        blockedAt: undefined,
        blockedBy: undefined,
      };

    return {
      op: kv.atomic().check(entry).set(keys.member(groupId, userId), next),
      result: next,
    };
  });
  if (!result) throw new Error("Block change did not apply");
  return result;
}

export async function updatePayout(
  kv: Deno.Kv,
  groupId: string,
  payout: PayoutDetails | null,
): Promise<Group> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Group>(kv, keys.group(groupId));
    if (!entry.value) throw new Error(`Group ${groupId} not found`);
    const next: Group = {
      ...entry.value,
      payout: payout ?? undefined,
      updatedAt: nowIso(),
    };
    return {
      op: kv.atomic().check(entry).set(keys.group(groupId), next),
      result: next,
    };
  });
  if (!result) throw new Error("Payout update did not apply");
  return result;
}

export async function listMembers(
  kv: Deno.Kv,
  groupId: string,
  limit = 500,
): Promise<Membership[]> {
  const rows = await listRecords<Membership>(
    kv,
    { prefix: ["member", groupId] },
    { limit },
  );
  return rows.map((r) => r.value);
}

/** A membership request that failed for a reason the organizer should read. */
export class MembershipError extends Error {}

/**
 * Adds an existing account to a group by email address.
 *
 * An email with no account is refused rather than pre-creating a placeholder
 * membership: that would let an organizer probe which addresses have ever
 * signed up. Someone without an account gets an invite link instead.
 */
export async function addMemberByEmail(
  kv: Deno.Kv,
  groupId: string,
  email: string,
  role: GroupRole = "player",
): Promise<Membership> {
  const user = await getUserByEmail(kv, email);
  if (!user) {
    throw new MembershipError(
      "No account uses that email yet. Send them an invite link instead.",
    );
  }
  return await ensureMembership(kv, groupId, user.id, role);
}

/**
 * Asks an organizer for a place in a group.
 *
 * Idempotent while pending: tapping the button twice does not queue twice, and
 * the original message and timestamp are kept. A rejected applicant may ask
 * again — a rejection is a decision about one request, not a permanent ban.
 * Blocking is the tool for that, and a blocked member is refused outright.
 */
export async function requestToJoin(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
  message?: string,
): Promise<JoinRequest> {
  const membership = await getMembership(kv, groupId, userId);
  if (membership?.blocked) {
    throw new MembershipError("You are blocked from this club.");
  }
  if (membership) {
    throw new MembershipError("You are already a member of this club.");
  }

  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<JoinRequest>(
      kv,
      keys.joinRequest(groupId, userId),
    );
    if (entry.value?.status === "pending") {
      return { op: kv.atomic().check(entry), result: entry.value };
    }

    const request: JoinRequest = {
      v: 1,
      groupId,
      userId,
      status: "pending",
      message,
      requestedAt: nowIso(),
    };
    return {
      op: kv.atomic().check(entry).set(
        keys.joinRequest(groupId, userId),
        request,
      ),
      result: request,
    };
  });

  if (!result) throw new MembershipError("That request did not go through.");
  return result;
}

export async function getJoinRequest(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
): Promise<JoinRequest | null> {
  const entry = await getRecord<JoinRequest>(
    kv,
    keys.joinRequest(groupId, userId),
  );
  return entry.value;
}

/** Every request ever made of a group, decided or not. */
export async function listJoinRequests(
  kv: Deno.Kv,
  groupId: string,
  limit = 200,
): Promise<JoinRequest[]> {
  const rows = await listRecords<JoinRequest>(
    kv,
    { prefix: keys.joinRequestsByGroupPrefix(groupId) },
    { limit },
  );
  return rows.map((row) => row.value);
}

/**
 * Settles a request, admitting the applicant when approved.
 *
 * The membership is written after the decision commits rather than inside it:
 * `ensureMembership` has its own atomic guard, and a decision recorded without
 * its membership is recoverable by approving again, whereas a membership with
 * no decision behind it is not.
 */
export async function decideJoinRequest(
  kv: Deno.Kv,
  groupId: string,
  userId: string,
  decision: "approved" | "rejected",
  deciderId: string,
): Promise<JoinRequest> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<JoinRequest>(
      kv,
      keys.joinRequest(groupId, userId),
    );
    if (!entry.value) throw new MembershipError("That request is gone.");
    if (entry.value.status !== "pending") {
      throw new MembershipError("That request has already been decided.");
    }

    const next: JoinRequest = {
      ...entry.value,
      status: decision,
      decidedAt: nowIso(),
      decidedBy: deciderId,
    };
    return {
      op: kv.atomic().check(entry).set(keys.joinRequest(groupId, userId), next),
      result: next,
    };
  });

  if (!result) throw new MembershipError("That decision did not apply.");
  if (decision === "approved") {
    await ensureMembership(kv, groupId, userId, "player");
  }
  return result;
}

/** An invite that cannot be redeemed, with a reason worth showing the user. */
export class InviteError extends Error {}

export interface IssuedInvite {
  /** The raw token, put in the link. Never stored. */
  token: string;
  expiresAt: string;
}

export async function issueGroupInvite(
  kv: Deno.Kv,
  groupId: string,
  createdBy: string,
): Promise<IssuedInvite> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const invite: GroupInvite = {
    v: 1,
    groupId,
    createdBy,
    createdAt: nowIso(),
    expiresAt,
  };

  await kv.set(keys.groupInvite(hash), invite, { expireIn: INVITE_TTL_MS });
  return { token, expiresAt };
}

/**
 * Redeems an invite, joining the redeemer as a player.
 *
 * Single use: the write is checked against the read, so two taps on the same
 * link cannot both succeed. The spent record is marked rather than deleted and
 * expires on its own — an invite link lives in a chat thread and gets tapped
 * again, and "already used" is a far better answer than "no such invite".
 *
 * An invite never grants organizer rights: promotion is a deliberate act on the
 * members page, never something a forwarded link can do.
 */
export async function consumeGroupInvite(
  kv: Deno.Kv,
  token: string,
  userId: string,
): Promise<Group> {
  const hash = await sha256Hex(token);
  const entry = await getRecord<GroupInvite>(kv, keys.groupInvite(hash));
  const invite = entry.value;
  if (!invite) throw new InviteError("That invite link is not valid.");

  const group = await getGroup(kv, invite.groupId);
  if (!group) throw new InviteError("That club no longer exists.");

  // Someone already in the club has nothing to redeem — including the person
  // who just redeemed this very link and opened it a second time.
  const existing = await getMembership(kv, group.id, userId);
  if (existing) return group;

  if (invite.redeemedAt) {
    throw new InviteError("That invite link has already been used.");
  }

  const redeemed: GroupInvite = {
    ...invite,
    redeemedAt: nowIso(),
    redeemedBy: userId,
  };

  // Preserve whatever life the record had left rather than resetting its TTL.
  const remainingMs = new Date(invite.expiresAt).getTime() - Date.now();
  const claimed = await kv.atomic()
    .check(entry)
    .set(keys.groupInvite(hash), redeemed, {
      expireIn: Math.max(remainingMs, 60 * 1000),
    })
    .commit();

  // Lost the race, so another request already redeemed this invite.
  if (!claimed.ok) {
    throw new InviteError("That invite link has already been used.");
  }

  await ensureMembership(kv, group.id, userId, "player");
  return group;
}
