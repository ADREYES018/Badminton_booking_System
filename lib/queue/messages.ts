/**
 * Queue message shapes and the helpers that schedule them.
 *
 * This module is deliberately separate from `dispatch.ts`. The data layer
 * enqueues messages, and the dispatcher calls the data layer — putting both
 * sides in one file would make that a circular import. Types and enqueue
 * helpers live here; the handler lives there.
 *
 * Two facts about Deno KV queues shape everything below:
 *
 *  1. There is no way to cancel or replace an enqueued message. Rescheduling
 *     is therefore "enqueue another one", and every handler must tolerate
 *     firing at the wrong time by re-checking the live record and, where
 *     appropriate, re-scheduling itself.
 *
 *  2. Delivery is at-least-once. Every handler must be idempotent — a repeat
 *     of the same message must be a no-op, not a second promotion or a second
 *     freeze.
 */

import { delayUntil } from "../domain/time.ts";
import type { ReminderTag } from "../types.ts";

export type QueueMessage =
  /** Freeze the roster and lock the per-head cost at the cutoff. */
  | { kind: "cutoff_freeze"; gameId: string }
  /** A seat came free: offer it to the head of the waitlist. */
  | { kind: "promote"; gameId: string }
  /** A promoted player's confirm window has run out. */
  | {
    kind: "promotion_expiry";
    gameId: string;
    userId: string;
    /**
     * Echoed back so the handler can tell a live deadline from a stale
     * message left over by an earlier promotion of the same player.
     */
    confirmDeadline: string;
  }
  /** Nudge the roster about an upcoming game and what they owe. */
  | { kind: "reminder"; gameId: string; tag: ReminderTag };

/** Narrows an untyped queue payload. Malformed messages are dropped. */
export function isQueueMessage(value: unknown): value is QueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { kind?: unknown; gameId?: unknown; tag?: unknown };
  if (typeof message.gameId !== "string") return false;
  if (message.kind === "reminder") {
    return REMINDER_TAGS.includes(message.tag as ReminderTag);
  }
  return message.kind === "cutoff_freeze" || message.kind === "promote" ||
    message.kind === "promotion_expiry";
}

/**
 * Reminder schedule, as hours before the game starts.
 *
 * "pay" fires at the cutoff, when the roster has just frozen and a figure to
 * pay finally exists — the spec's T-72h payment reminder would have fired
 * before payment was possible under a 48-hour cutoff. See DECISIONS.md.
 */
export const REMINDER_TAGS: readonly ReminderTag[] = [
  "pay",
  "t36",
  "t24",
  "t3",
];

const REMINDER_HOURS: Record<Exclude<ReminderTag, "pay">, number> = {
  t36: 36,
  t24: 24,
  t3: 3,
};

/**
 * Schedules every reminder a game still has coming.
 *
 * Called at the freeze, so "pay" goes out immediately and the rest are spaced
 * by their offset. Reminders already in the past are skipped rather than fired
 * late — telling someone about a game that started an hour ago helps nobody.
 */
export async function enqueueReminders(
  kv: Deno.Kv,
  gameId: string,
  startUtc: string,
): Promise<void> {
  await kv.enqueue(
    { kind: "reminder", gameId, tag: "pay" } satisfies QueueMessage,
  );

  const start = new Date(startUtc).getTime();
  for (const [tag, hours] of Object.entries(REMINDER_HOURS)) {
    const at = new Date(start - hours * 60 * 60 * 1000);
    if (at.getTime() <= Date.now()) continue;
    await kv.enqueue(
      {
        kind: "reminder",
        gameId,
        tag: tag as ReminderTag,
      } satisfies QueueMessage,
      { delay: delayUntil(at.toISOString()) },
    );
  }
}

/**
 * Schedules the roster freeze for a game's cutoff instant.
 *
 * Safe to call repeatedly. Because messages cannot be cancelled, an edit that
 * moves the start time simply schedules another one; the earlier message fires
 * early, notices the cutoff has not arrived, and re-schedules itself.
 */
export async function enqueueCutoffFreeze(
  kv: Deno.Kv,
  gameId: string,
  cutoffIso: string,
): Promise<void> {
  await kv.enqueue(
    { kind: "cutoff_freeze", gameId } satisfies QueueMessage,
    { delay: delayUntil(cutoffIso) },
  );
}

/** Asks the waitlist to fill a seat. No delay — the seat is free now. */
export async function enqueuePromotion(
  kv: Deno.Kv,
  gameId: string,
): Promise<void> {
  await kv.enqueue({ kind: "promote", gameId } satisfies QueueMessage);
}

export async function enqueuePromotionExpiry(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  confirmDeadline: string,
): Promise<void> {
  await kv.enqueue(
    {
      kind: "promotion_expiry",
      gameId,
      userId,
      confirmDeadline,
    } satisfies QueueMessage,
    { delay: delayUntil(confirmDeadline) },
  );
}
