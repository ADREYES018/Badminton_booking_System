/**
 * Where a signed-in user goes when a bare path cannot name a club for them.
 *
 * `/games`, `/stats` and `/checkin` predate clubs having URLs. They are kept
 * as redirects so old links, bookmarks and the club-agnostic bottom navigation
 * all still land somewhere sensible.
 *
 * One club is not a choice worth showing, so it is followed straight through.
 * None and several both land on the club list, which either explains how to get
 * in or asks which one they meant.
 */

import type { AuthState } from "../auth/middleware.ts";
import { requireUser } from "../auth/middleware.ts";
import { listGroupsForUser } from "../data/groups.ts";

export type GroupSuffix = "games" | "stats" | "checkin";

export interface RedirectingContext {
  state: { auth: AuthState };
  redirect: (path: string) => Response;
}

export async function redirectToGroup(
  ctx: RedirectingContext,
  suffix: GroupSuffix,
): Promise<Response> {
  const user = requireUser(ctx.state.auth);
  const groups = await listGroupsForUser(ctx.state.auth.kv, user.id);
  const only = groups.length === 1 ? groups[0] : undefined;
  return ctx.redirect(only ? `/g/${only.slug}/${suffix}` : "/groups");
}
