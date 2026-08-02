/**
 * The queue listener.
 *
 * One handler, registered once at boot, routing delayed messages to the data
 * layer. Everything it calls is idempotent, because Deno KV delivers at least
 * once and a duplicate must not promote a second player or freeze a roster
 * twice.
 *
 * A handler that promotes someone may need to schedule the expiry of that
 * promotion, and an expiry cascades to the next person in line. Those follow-on
 * messages are enqueued here, after the commit that produced them — never from
 * inside a `withRetry` callback, which may run several times.
 */

import {
  expirePromotion,
  flush,
  freezeRoster,
  promoteNext,
} from "../data/signups.ts";
import { sendReminder } from "../data/reminders.ts";
import { isQueueMessage, type QueueMessage } from "./messages.ts";

/**
 * Routes one message. Errors are logged rather than thrown: an unhandled
 * rejection here would retry the message indefinitely, and the lazy
 * sweep-on-read in the routes is the backstop for anything genuinely lost.
 */
export async function handleQueueMessage(
  kv: Deno.Kv,
  raw: unknown,
): Promise<void> {
  if (!isQueueMessage(raw)) {
    console.warn("Dropping unrecognised queue message", raw);
    return;
  }

  const message: QueueMessage = raw;

  try {
    switch (message.kind) {
      case "cutoff_freeze": {
        await freezeRoster(kv, message.gameId);
        break;
      }

      case "promote": {
        const result = await promoteNext(kv, message.gameId);
        await flush(kv, result.effects);
        break;
      }

      case "promotion_expiry": {
        const result = await expirePromotion(
          kv,
          message.gameId,
          message.userId,
          message.confirmDeadline,
        );
        await flush(kv, result.effects);
        break;
      }

      case "reminder": {
        await sendReminder(kv, message.gameId, message.tag);
        break;
      }
    }
  } catch (error) {
    console.error(`Queue handler failed for ${message.kind}`, error);
  }
}

/**
 * Starts listening. Called once from `main.ts`, never from a test — tests
 * drive the handler directly so they do not depend on delivery timing.
 */
export function startQueueListener(kv: Deno.Kv): void {
  kv.listenQueue((raw) => handleQueueMessage(kv, raw));
}
