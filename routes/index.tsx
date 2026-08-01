/**
 * Root route. Signed-in players go to their games; everyone else is sent to
 * sign in. There is no separate marketing page in Phase 1.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";

export function indexRoute(app: App<State>) {
  app.get("/", (ctx) => {
    return ctx.redirect(ctx.state.auth.user ? "/games" : "/auth/login");
  });
}
