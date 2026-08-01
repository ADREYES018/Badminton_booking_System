/**
 * Groups and membership.
 *
 * Phase 2 runs a single club: one group is seeded on demand and every signed-in
 * user joins it automatically. The records are nevertheless real `Group` and
 * `Membership` rows behind the same key schema a multi-group build would use,
 * so adding a second group later is a routing and UI problem rather than a
 * migration.
 *
 * `ensureDefaultGroup` is idempotent and safe to call concurrently: the slug
 * index is reserved inside the same atomic commit that writes the record, the
 * same way `createUser` reserves an email. Correctness therefore does not
 * depend on `main.ts` having run first, which matters because tests call the
 * data layer directly.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import { getRecord, listRecords, withRetry } from "../kv/kv.ts";
import type { Group, GroupRole, Membership, PayoutDetails } from "../types.ts";
import { nowIso } from "../domain/time.ts";

/** Slug of the club every Phase 2 user belongs to. */
export const DEFAULT_GROUP_SLUG = "smash-club";

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
