/**
 * Read-triggered correction.
 *
 * The queue is the primary mechanism for freezing a roster at the cutoff and
 * for expiring a promotion nobody answered. This is the backstop for when a
 * message never arrives — a process restarted mid-delay, a local development
 * database that was closed, a delivery that was simply lost.
 *
 * The same idea already appears in Phase 1, where a session rolls its own
 * expiry forward when it happens to be read. Correcting on read costs nothing
 * when there is nothing to correct: both checks below are pure arithmetic on a
 * record the caller has already loaded, and only touch KV when they find
 * something genuinely overdue.
 *
 * Sweeps never block the response. A page load that triggers a freeze does not
 * wait for it — the caller renders from the record it already has, and the
 * correction lands before the next read.
 */

import type { Game } from "../types.ts";
import { isPastCutoff } from "../domain/time.ts";
import { expirePromotion, flush, freezeRoster, listRoster } from "./signups.ts";

/** True when the cutoff has passed but the roster was never frozen. */
export function needsFreeze(game: Game, now: Date = new Date()): boolean {
  if (game.rosterFrozenAt) return false;
  if (game.status === "cancelled" || game.status === "draft") return false;
  return isPastCutoff(game.startUtc, game.cutoffHours, now);
}

/**
 * Brings one game up to date: freezes an overdue roster, and releases any
 * held seat whose confirm window has run out.
 *
 * Safe to call on every read. Each step is idempotent and returns quickly when
 * there is nothing to do.
 */
export async function sweepGame(
  kv: Deno.Kv,
  game: Game,
  now: Date = new Date(),
): Promise<void> {
  if (game.status === "cancelled") return;

  if (needsFreeze(game, now)) {
    await freezeRoster(kv, game.id);
  }

  // A held seat past its deadline blocks the court for everyone behind it, so
  // this matters more than the freeze does.
  if (game.pendingCount > 0) {
    const pending = await listRoster(kv, game.id, "pending_confirm");
    for (const signup of pending) {
      if (!signup.confirmDeadline) continue;
      if (now < new Date(signup.confirmDeadline)) continue;

      const result = await expirePromotion(
        kv,
        game.id,
        signup.userId,
        signup.confirmDeadline,
      );
      await flush(kv, result.effects);
    }
  }
}

/**
 * Fire-and-forget sweep for a request path.
 *
 * The caller renders from the record it already read; the correction applies
 * in the background and is visible on the next load. Failures are logged, not
 * propagated — a stale figure on one page view is a much smaller problem than
 * a page that fails to render.
 */
export function sweepInBackground(kv: Deno.Kv, game: Game): void {
  sweepGame(kv, game).catch((error) => {
    console.error(`Sweep failed for game ${game.id}`, error);
  });
}
