/**
 * Application entry point.
 *
 * Routes are registered explicitly on the App instance rather than by file
 * convention, so every route's auth requirements are visible in one place.
 */

import { App, staticFiles } from "fresh";
import { loadAuthState } from "./lib/auth/middleware.ts";
import type { AuthState } from "./lib/auth/middleware.ts";
import { handleRouteError } from "./lib/auth/error_middleware.ts";

import { indexRoute } from "./routes/index.tsx";
import { loginRoutes } from "./routes/auth/login.tsx";
import { verifyRoute } from "./routes/auth/verify.tsx";
import { logoutRoute } from "./routes/auth/logout.ts";
import { gamesRoute } from "./routes/games.tsx";
import { profileRoutes } from "./routes/profile.tsx";
import { photoRoute } from "./routes/api/photo.ts";
import { manifestRoute } from "./routes/api/manifest.ts";

export interface State {
  auth: AuthState;
}

export const app = new App<State>();

app.use(staticFiles());

// Convert HttpError into redirects and error pages. Registered before the
// routes so it wraps every handler below it.
app.use(async (ctx) => {
  try {
    return await ctx.next();
  } catch (error) {
    return handleRouteError(ctx.req, error);
  }
});

// Resolve the session once per request; individual routes then assert the
// access level they need.
app.use(async (ctx) => {
  ctx.state.auth = await loadAuthState(ctx.req);
  return await ctx.next();
});

indexRoute(app);
loginRoutes(app);
verifyRoute(app);
logoutRoute(app);
gamesRoute(app);
profileRoutes(app);
photoRoute(app);
manifestRoute(app);

if (import.meta.main) {
  await app.listen();
}
