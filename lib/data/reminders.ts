/**
 * Reminder delivery.
 *
 * Queue delivery is at-least-once, so the interesting problem here is not
 * sending an email — it is not sending it twice. A player who gets the same
 * "you owe AED 30" message three times learns to ignore all of them.
 *
 * Each signup records which tags it has already received. A tag is claimed
 * under a versionstamp check *before* the email goes out, so two concurrent
 * deliveries of the same message cannot both win the claim. The cost of that
 * ordering is that a send failing after the claim means the reminder is lost
 * rather than repeated, which is the right way round: a missed nudge is a
 * smaller harm than a mailbox full of duplicates, and the next reminder in
 * the schedule still arrives.
 */

import { keys } from "../kv/keys.ts";
import { getRecord, withRetry } from "../kv/kv.ts";
import type { Game, ReminderTag, Signup, User } from "../types.ts";
import { listRoster } from "./signups.ts";
import { getUser } from "./users.ts";
import { sendEmail } from "../email.ts";
import { reminderEmail } from "../email.ts";
import { currentSplit } from "../domain/money.ts";

/**
 * Claims a reminder tag for one signup.
 *
 * Returns false when the tag was already recorded — either a duplicate
 * delivery or a concurrent one that got there first.
 */
async function claimTag(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  tag: ReminderTag,
): Promise<boolean> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Signup>(kv, keys.signup(gameId, userId));
    const signup = entry.value;
    if (!signup) return null;
    if (signup.remindersSent.includes(tag)) return null;
    // Someone who left does not need reminding about a game they are not in.
    if (signup.status !== "confirmed") return null;

    return {
      op: kv.atomic().check(entry).set(
        keys.signup(gameId, userId),
        {
          ...signup,
          remindersSent: [...signup.remindersSent, tag],
          updatedAt: new Date().toISOString(),
        } satisfies Signup,
      ),
      result: true,
    };
  });

  return result === true;
}

export interface ReminderOutcome {
  sent: number;
  skipped: number;
}

/**
 * Sends one reminder to every confirmed player who has not had it yet.
 *
 * A cancelled game reminds nobody. Neither does a game that has already
 * started — a late message is worse than none.
 */
export async function sendReminder(
  kv: Deno.Kv,
  gameId: string,
  tag: ReminderTag,
): Promise<ReminderOutcome> {
  const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
  const game = gameEntry.value;
  if (!game) return { sent: 0, skipped: 0 };
  if (game.status === "cancelled") return { sent: 0, skipped: 0 };
  if (new Date() >= new Date(game.startUtc)) return { sent: 0, skipped: 0 };

  const confirmed = await listRoster(kv, gameId, "confirmed");
  const split = currentSplit(game);

  let sent = 0;
  let skipped = 0;

  for (const signup of confirmed) {
    // Claim first: a failure after this loses one reminder, whereas sending
    // first and failing to record it repeats the reminder on every delivery.
    if (!await claimTag(kv, gameId, signup.userId, tag)) {
      skipped++;
      continue;
    }

    const user: User | null = await getUser(kv, signup.userId);
    if (!user?.email) {
      skipped++;
      continue;
    }

    const owed = signup.owedFils ?? split.perHeadFils;
    await sendEmail(reminderEmail(user.email, game, tag, owed));
    sent++;
  }

  return { sent, skipped };
}
