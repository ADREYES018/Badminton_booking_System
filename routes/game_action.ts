/**
 * The shape every game action shares.
 *
 * RSVP, payment, results and attendance all do the same four things:
 * authenticate, verify CSRF, run one backend call, and redirect with a
 * message. Keeping that here rather than in each route file means the
 * `SignupError`-versus-bug distinction is written once.
 *
 * That distinction is the reason this exists at all. A `SignupError` is a
 * refusal the player can act on and must come back as a readable message;
 * anything else is a bug and has to keep propagating to the error handler.
 * Getting it wrong in one copy out of a dozen is exactly the kind of drift
 * that goes unnoticed.
 */

import type { State } from "../main.ts";
import {
  clientIp,
  CSRF_FIELD,
  HttpError,
  requireUser,
  verifyCsrf,
} from "../lib/auth/middleware.ts";
import { getGameBySlug } from "../lib/data/games.ts";
import { SignupError } from "../lib/data/signups.ts";
import { ensureDefaultGroup, ensureMembership } from "../lib/data/groups.ts";
import { audit, type AuditAction } from "../lib/data/audit.ts";
import type { Game, User } from "../lib/types.ts";

/** The minimum a Fresh context needs to expose for these helpers. */
export interface ActionCtx {
  req: Request;
  params: Record<string, string | undefined>;
  state: State;
}

/**
 * What an action that changed something reports back.
 *
 * `redirect` overrides where the player lands without costing the audit
 * entry. Returning a bare `Response` skips auditing, which is right for a
 * validation failure and wrong for anything that touched money.
 */
export interface ActionOutcome {
  action: AuditAction;
  notice: string;
  redirect?: Response;
}

export interface ActionContext {
  user: User;
  kv: Deno.Kv;
  form: FormData;
  game: Game;
}

/** Redirect carrying a message, so a refresh never resubmits the action. */
export function backToGame(
  slug: string,
  params: Record<string, string> = {},
): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { location: `/games/${slug}${query ? `?${query}` : ""}` },
  });
}

/**
 * Shared prologue: authenticate, verify CSRF, load the game, and make sure
 * the player is a member of the club.
 */
export async function begin(ctx: ActionCtx): Promise<ActionContext> {
  const user = requireUser(ctx.state.auth);
  const kv = ctx.state.auth.kv;
  const form = await ctx.req.formData();

  if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
    throw new HttpError(403, "That form expired. Please try again.");
  }

  const game = await getGameBySlug(kv, ctx.params.slug!);
  if (!game) throw new HttpError(404, "That game could not be found");

  const group = await ensureDefaultGroup(kv, user.id);
  // The seeded role matters: `ensureMembership` only writes on the first
  // touch, so seating an organizer as a player here would deny them their own
  // group's controls forever after. This mirrors `organizerContext`.
  await ensureMembership(
    kv,
    group.id,
    user.id,
    user.role === "player" ? "player" : "organizer",
  );

  return { user, kv, form, game };
}

/**
 * Runs one action: perform it, record the audit entry, and redirect with the
 * resulting message.
 *
 * Returning a `Response` from `run` skips the audit entry — that is the path
 * for a validation failure, which records nothing because nothing happened.
 */
export async function act(
  ctx: ActionCtx,
  run: (
    context: ActionContext,
  ) => Promise<ActionOutcome | Response>,
): Promise<Response> {
  const context = await begin(ctx);

  try {
    const outcome = await run(context);
    // A bare Response is a validation failure: it changed nothing, so there
    // is nothing to record.
    if (outcome instanceof Response) return outcome;

    await audit(context.kv, {
      actorId: context.user.id,
      action: outcome.action,
      targetId: context.game.id,
      groupId: context.game.groupId,
      ip: clientIp(ctx.req),
    });

    // An action that changed something may still choose where to land — the
    // organizer's payment controls send them back to the settlement screen
    // they were working through. Auditing happens either way.
    return outcome.redirect ??
      backToGame(context.game.slug, { notice: outcome.notice });
  } catch (error) {
    if (error instanceof SignupError) {
      return backToGame(context.game.slug, { error: error.message });
    }
    throw error;
  }
}
