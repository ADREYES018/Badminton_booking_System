/**
 * Audit trail for state-changing admin actions.
 *
 * Entries are scoped by group so an organizer's reads can never span groups;
 * platform-level actions land in a "platform" scope only super_admins read.
 */

import { keys, seqKey } from "../kv/keys.ts";
import { listRecords } from "../kv/kv.ts";
import type { AuditEntry } from "../types.ts";
import { nowIso } from "../domain/time.ts";

export const PLATFORM_SCOPE = "platform";

/** Actions worth recording. Kept as a union so callers cannot invent strings. */
export type AuditAction =
  | "user.role_changed"
  | "user.iban_decrypted"
  | "group.created"
  | "group.updated"
  | "group.payout_updated"
  | "member.added"
  | "member.invited"
  | "member.request_decided"
  | "member.role_changed"
  | "member.blocked"
  | "member.unblocked"
  | "member.removed"
  | "game.created"
  | "game.updated"
  | "game.cancelled"
  | "game.deleted"
  | "game.cutoff_overridden"
  | "game.unlocked"
  | "game.access_requested"
  | "game.access_approved"
  | "game.access_rejected"
  | "game.court_added"
  | "signup.payment_marked"
  | "signup.payment_confirmed"
  | "signup.refunded"
  | "signup.forfeited"
  | "signup.force_promoted"
  | "signup.cancelled_by_organizer"
  | "signup.attendance_overridden"
  | "game.roster_frozen"
  | "signup.joined"
  | "signup.waitlisted"
  | "signup.left"
  | "signup.promoted"
  | "signup.promotion_confirmed"
  | "signup.promotion_expired"
  | "guest.added"
  | "guest.removed"
  | "match.reported"
  | "match.confirmed"
  | "match.disputed";

export interface AuditInput {
  actorId: string;
  action: AuditAction;
  targetId?: string;
  /**
   * The club the action happened in, if any. `null` is accepted as well as
   * absent so a caller can pass a clubless game's `groupId` straight through:
   * both mean "no club", and forcing every call site to convert one into the
   * other would be ceremony that buys nothing.
   */
  groupId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

let counter = 0;

/**
 * Appends an audit entry. Never throws into the caller's path — losing a log
 * line must not roll back the action it describes, but it is reported.
 */
export async function audit(kv: Deno.Kv, input: AuditInput): Promise<void> {
  const entry: AuditEntry = {
    v: 1,
    actorId: input.actorId,
    targetId: input.targetId,
    // Normalized to undefined so a clubless entry stores no key at all rather
    // than an explicit null, matching every entry written before clubless
    // games existed.
    groupId: input.groupId ?? undefined,
    action: input.action,
    before: input.before,
    after: input.after,
    ip: input.ip,
    ts: nowIso(),
  };

  const scope = input.groupId ?? PLATFORM_SCOPE;
  // Counter breaks ties when two entries land in the same millisecond.
  counter = (counter + 1) % 1_000_000;

  try {
    await kv.set(keys.audit(scope, entry.ts, seqKey(counter)), entry);
  } catch (error) {
    console.error("Failed to write audit entry", input.action, error);
  }
}

/** Most recent entries first. */
export async function listAudit(
  kv: Deno.Kv,
  scope: string,
  limit = 100,
): Promise<AuditEntry[]> {
  const rows = await listRecords<AuditEntry>(
    kv,
    { prefix: ["audit", scope] },
    { limit, reverse: true },
  );
  return rows.map((r) => r.value);
}
