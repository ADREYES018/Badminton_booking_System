/**
 * Payment, result and attendance actions for a game.
 *
 * These share `act` with the RSVP routes in `game.tsx`, so they inherit the
 * same contract: form POST, one backend call, redirect with a message, and a
 * `SignupError` surfaced as readable text rather than a stack trace.
 *
 * The organizer-only actions verify the caller against the game's own group
 * rather than a global role. Being an organizer somewhere is not being an
 * organizer here.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { HttpError, requireOrganizer } from "../lib/auth/middleware.ts";
import { act, backToGame } from "./game_action.ts";
import { confirmPaid, markPaid, refundPayment } from "../lib/data/signups.ts";
import {
  confirmMatch,
  listMatchesForGame,
  rejectMatch,
  reportMatch,
  setAttendance,
} from "../lib/data/matches.ts";

/** Redirect back to the organizer's settlement screen for this game. */
function backToSettlement(slug: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: {
      location: `/organizer/games/${slug}/settlement${
        query ? `?${query}` : ""
      }`,
    },
  });
}

export function gameActionRoutes(app: App<State>) {
  // ---- Payment ------------------------------------------------------------

  /** The player's own claim that they have transferred their share. */
  app.post(
    "/games/:slug/paid",
    (ctx) =>
      act(ctx, async ({ user, kv, game }) => {
        await markPaid(kv, game.id, user.id);
        return {
          action: "signup.payment_marked",
          notice: "Thanks — the organizer will confirm it once it lands.",
        };
      }),
  );

  /**
   * The organizer confirming money arrived, and recording a refund.
   *
   * Both redirect to the settlement screen rather than the game page: that is
   * where the organizer was, and sending them to the player-facing page after
   * every row would make settling a roster tedious.
   */
  app.post(
    "/games/:slug/payments/confirm",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        await requireOrganizer(ctx.state.auth, game.groupId);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        await confirmPaid(kv, game.id, userId, user.id);
        return {
          action: "signup.payment_confirmed",
          notice: "Payment confirmed.",
          redirect: backToSettlement(game.slug, {
            notice: "Payment confirmed.",
          }),
        };
      }),
  );

  app.post(
    "/games/:slug/payments/refund",
    (ctx) =>
      act(ctx, async ({ kv, form, game }) => {
        await requireOrganizer(ctx.state.auth, game.groupId);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        await refundPayment(kv, game.id, userId);
        return {
          action: "signup.refunded",
          notice: "Refund recorded.",
          redirect: backToSettlement(game.slug, {
            notice: "Refund recorded.",
          }),
        };
      }),
  );

  // ---- Results ------------------------------------------------------------

  /**
   * Reporting a doubles result.
   *
   * Validation stays in `reportMatch` — duplicate players, a draw, negative
   * scores and a reporter who did not play are all refused there. Repeating
   * those rules here would mean maintaining them twice.
   */
  app.post(
    "/games/:slug/results",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        const player = (field: string) => form.get(field)?.toString() ?? "";
        const score = (field: string) => Number(form.get(field)?.toString());

        const scoreA = score("scoreA");
        const scoreB = score("scoreB");
        if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB)) {
          return backToGame(game.slug, {
            error: "Enter both scores as whole numbers.",
          });
        }

        await reportMatch(kv, {
          gameId: game.id,
          groupId: game.groupId,
          sideA: [player("a1"), player("a2")],
          sideB: [player("b1"), player("b2")],
          scoreA,
          scoreB,
          reportedBy: user.id,
        });

        return {
          action: "match.reported",
          notice: "Result recorded. The losing side confirms it.",
        };
      }),
  );

  app.post(
    "/games/:slug/results/confirm",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        const matchId = form.get("matchId")?.toString() ?? "";
        await assertMatchBelongsToGame(kv, matchId, game.id);

        await confirmMatch(kv, matchId, user.id);
        return { action: "match.confirmed", notice: "Result confirmed." };
      }),
  );

  app.post(
    "/games/:slug/results/dispute",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        const matchId = form.get("matchId")?.toString() ?? "";
        await assertMatchBelongsToGame(kv, matchId, game.id);

        await rejectMatch(kv, matchId, user.id);
        return {
          action: "match.disputed",
          notice: "Result disputed. It counts toward nobody's record.",
        };
      }),
  );

  // ---- Attendance ---------------------------------------------------------

  app.post(
    "/games/:slug/attendance",
    (ctx) =>
      act(ctx, async ({ kv, form, game }) => {
        await requireOrganizer(ctx.state.auth, game.groupId);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        await setAttendance(kv, game.id, userId, form.get("attended") === "1", {
          groupId: game.groupId,
        });

        return {
          action: "signup.attendance_overridden",
          notice: "Attendance updated.",
        };
      }),
  );
}

/**
 * Refuses a match id that belongs to a different game.
 *
 * The slug in the URL decides which game's permissions were checked, so a
 * match id from elsewhere would be acted on under the wrong game's context.
 */
async function assertMatchBelongsToGame(
  kv: Deno.Kv,
  matchId: string,
  gameId: string,
): Promise<void> {
  const matches = await listMatchesForGame(kv, gameId);
  if (!matches.some((match) => match.id === matchId)) {
    throw new HttpError(404, "That result is not on this game.");
  }
}
