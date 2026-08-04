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
import {
  clientIp,
  HttpError,
  requireOrganizer,
} from "../lib/auth/middleware.ts";
import { act, backToGame, begin } from "./game_action.ts";
import {
  confirmPaid,
  getSignup,
  markPaid,
  refundPayment,
  SignupError,
} from "../lib/data/signups.ts";
import { audit } from "../lib/data/audit.ts";
import { getUser } from "../lib/data/users.ts";
import { getGroup } from "../lib/data/groups.ts";
import { paymentClaimedEmail, sendEmail } from "../lib/email.ts";
import { amountOwed } from "../lib/domain/money.ts";
import type { Game, Signup, User } from "../lib/types.ts";
import {
  CheckinError,
  checkinVersionOf,
  verifyCheckinToken,
} from "../lib/domain/checkin.ts";
import {
  confirmMatch,
  listMatchesForGame,
  rejectMatch,
  reportMatch,
  setAttendance,
} from "../lib/data/matches.ts";

/**
 * Tells the organizer a player says they have paid.
 *
 * Deliberately not awaited into the player's response, and deliberately never
 * throwing: the claim is already recorded in KV by the time this runs, and a
 * mail provider having a bad minute must not turn a successful payment claim
 * into an error the player sees and retries.
 *
 * Goes to the group owner, who is the account holder — a second organizer can
 * see the claim on the settlement screen, but only the owner can look at the
 * statement it needs checking against.
 */
async function notifyOrganizerOfPayment(
  kv: Deno.Kv,
  game: Game,
  player: User,
  signup: Signup,
): Promise<void> {
  try {
    const group = await getGroup(kv, game.groupId);
    if (!group) return;

    const owner = await getUser(kv, group.ownerId);
    if (!owner?.email) return;

    // A player paying for their own game would be telling themselves.
    if (owner.id === player.id) return;

    await sendEmail(
      paymentClaimedEmail(
        owner.email,
        game,
        player.name,
        amountOwed(signup, game),
      ),
    );
  } catch (error) {
    console.error(`Payment notice failed for game ${game.id}`, error);
  }
}

/** Redirect back to the organizer's settlement screen for this game. */
function backToSettlement(
  groupSlug: string,
  slug: string,
  params: Record<string, string> = {},
) {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: {
      location: `/g/${groupSlug}/organizer/games/${slug}/settlement${
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
        const signup = await markPaid(kv, game.id, user.id);
        await notifyOrganizerOfPayment(kv, game, user, signup);
        return {
          action: "signup.payment_marked",
          notice:
            "Thanks — tell the organizer you have sent it, and they will " +
            "confirm it once it lands.",
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
        const { group } = await requireOrganizer(ctx.state.auth, game.groupId);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        await confirmPaid(kv, game.id, userId, user.id);
        return {
          action: "signup.payment_confirmed",
          notice: "Payment confirmed.",
          redirect: backToSettlement(group.slug, game.slug, {
            notice: "Payment confirmed.",
          }),
        };
      }),
  );

  app.post(
    "/games/:slug/payments/refund",
    (ctx) =>
      act(ctx, async ({ kv, form, game }) => {
        const { group } = await requireOrganizer(ctx.state.auth, game.groupId);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        await refundPayment(kv, game.id, userId);
        return {
          action: "signup.refunded",
          notice: "Refund recorded.",
          redirect: backToSettlement(group.slug, game.slug, {
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

  // ---- Check-in -----------------------------------------------------------

  /**
   * Scanning a code.
   *
   * The only JSON endpoint in the app. Every other action is a form POST that
   * redirects, but a scanner works through a queue: reloading the page between
   * players would lose the camera stream and the organizer's place in the
   * line. The reply carries the player's name so the island can confirm who
   * was just admitted.
   *
   * Four gates, in order: the scanner must be an organizer of this game's
   * club, the code must verify, its version must still be the player's
   * current one, and the player must be confirmed on this game's roster.
   *
   * The last is load-bearing. The code carries no game and never expires, so
   * without a roster check a code scanned anywhere would mark its owner
   * present anywhere.
   *
   * The version gate cannot live in verification: a superseded code still
   * verifies as its own old version, and only the stored record knows which
   * version is current.
   *
   * The organizer guard is what makes the direction of the scan safe — the
   * POST comes from the organizer's browser carrying a token the player
   * displayed, so a player replaying their own token still cannot mark
   * themselves.
   */
  app.post("/games/:slug/checkin", async (ctx) => {
    const context = await begin(ctx);
    const { kv, form, game } = context;

    await requireOrganizer(ctx.state.auth, game.groupId);

    const reply = (status: number, body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    try {
      const token = form.get("token")?.toString() ?? "";
      const claim = await verifyCheckinToken(token);

      const player = await getUser(kv, claim.userId);
      if (!player) {
        throw new CheckinError("That code belongs to no one.");
      }

      // A code the player has replaced is dead, whoever is holding it.
      if (claim.version !== checkinVersionOf(player)) {
        throw new CheckinError(
          "That code has been replaced. Ask for the current one.",
        );
      }

      const signup = await getSignup(kv, game.id, claim.userId);
      if (signup?.status !== "confirmed") {
        throw new CheckinError(
          `${player.name} is not on the roster for this game.`,
        );
      }

      await setAttendance(kv, game.id, claim.userId, true, {
        groupId: game.groupId,
      });

      await audit(kv, {
        actorId: context.user.id,
        action: "signup.attendance_overridden",
        targetId: game.id,
        groupId: game.groupId,
        ip: clientIp(ctx.req),
      });

      return reply(200, {
        ok: true,
        userId: claim.userId,
        name: player.name,
      });
    } catch (error) {
      // A bad code is an ordinary event at a door — a stale screenshot, a
      // code for last week's game. It comes back as a message the scanner can
      // show, not as a 500.
      if (error instanceof CheckinError || error instanceof SignupError) {
        return reply(400, { ok: false, error: error.message });
      }
      throw error;
    }
  });

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
