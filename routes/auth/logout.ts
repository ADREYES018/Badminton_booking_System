/**
 * Sign out. POST only, so a stray link or image cannot end someone's session.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import {
  CSRF_FIELD,
  isSecureRequest,
  verifyCsrf,
} from "../../lib/auth/middleware.ts";
import { clearSessionCookie, destroySession } from "../../lib/auth/session.ts";

export function logoutRoute(app: App<State>) {
  app.post("/auth/logout", async (ctx) => {
    const form = await ctx.req.formData();
    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      return ctx.redirect("/profile");
    }

    const { kv, user, sessionId } = ctx.state.auth;
    if (user && sessionId) {
      await destroySession(kv, { id: sessionId, userId: user.id });
    }

    const response = ctx.redirect("/auth/login");
    response.headers.append(
      "set-cookie",
      clearSessionCookie(isSecureRequest(ctx.req)),
    );
    return response;
  });
}
