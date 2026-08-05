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
import { getKv } from "./lib/kv/kv.ts";
import { assertSecretsPresent } from "./lib/crypto.ts";
import { startQueueListener } from "./lib/queue/dispatch.ts";

import AppWrapper from "./routes/_app.tsx";
import { indexRoute } from "./routes/index.tsx";
import { loginRoutes } from "./routes/auth/login.tsx";
import { verifyRoute } from "./routes/auth/verify.tsx";
import { logoutRoute } from "./routes/auth/logout.ts";
import { groupsRoutes } from "./routes/groups.tsx";
import { groupMemberRoutes } from "./routes/group_members.tsx";
import { groupSettingsRoutes } from "./routes/group_settings.tsx";
import { gamesRoute } from "./routes/games.tsx";
import { gameRoute } from "./routes/game.tsx";
import { gameActionRoutes } from "./routes/game_actions.tsx";
import { organizerGameRoutes } from "./routes/organizer/games.tsx";
import { settlementRoute } from "./routes/organizer/settlement.tsx";
import { profileRoutes } from "./routes/profile.tsx";
import { statsRoute } from "./routes/stats.tsx";
import { checkinRoute } from "./routes/checkin.tsx";
import { photoRoute } from "./routes/api/photo.ts";
import { manifestRoute } from "./routes/api/manifest.ts";

export interface State {
  auth: AuthState;
}

export const app = new App<State>();

/**
 * Warns at boot when a secret is missing.
 *
 * The keys are built lazily, so without this a server started with no
 * `APP_SECRET` boots cleanly, serves most of the app, and then throws a 500 on
 * the first page that mints a check-in token. The action that led there has
 * already succeeded by then, so the failure reads as a bug in whichever button
 * was pressed rather than as missing configuration.
 *
 * A warning rather than a throw: tests import this module and set their
 * secrets afterwards, and `deno task check` type-checks it with no environment
 * at all. The 500 is still a 500 — what this buys is a line at startup saying
 * why.
 */
assertSecretsPresent().catch((error: unknown) => {
  console.error(
    `Startup check failed — requests needing this will return 500.\n  ${
      error instanceof Error ? error.message : String(error)
    }\n  Run through 'deno task start', which loads .env.`,
  );
});

/**
 * The HTML document every page renders inside.
 *
 * Registered by hand because routes are. File-based routing would pick
 * `routes/_app.tsx` up on its own, but this app registers each route
 * explicitly — and without this call Fresh emits its own minimal head, which
 * silently drops the viewport tag and leaves every phone laying the site out
 * at 980px and scaling it down.
 */
app.appWrapper(AppWrapper);

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
groupsRoutes(app);
groupMemberRoutes(app);
groupSettingsRoutes(app);
gamesRoute(app);
// Registered before /games/:slug so the organizer paths are not swallowed by
// the slug pattern.
organizerGameRoutes(app);
settlementRoute(app);
gameRoute(app);
gameActionRoutes(app);
profileRoutes(app);
statsRoute(app);
checkinRoute(app);
photoRoute(app);
manifestRoute(app);

// The waitlist and the cutoff freeze run on delayed queue messages, so a
// server that never registers the listener throws on the first `kv.enqueue` —
// which is exactly the two actions that enqueue one, posting a game and
// cancelling a spot.
//
// This cannot live under `import.meta.main`. Deploy runs the app through
// `deno serve` against the built bundle, so the entry module is that bundle
// rather than this file and the guard is false — the listener would never be
// registered in production, which is the one place it matters most.
//
// Tests are the reason it is gated at all rather than being unconditional:
// several route tests import this module, and registering at import time would
// open the real database and make delivery timing part of the suite. Tests
// drive the handler directly instead.
if (import.meta.main || Deno.env.get("DENO_DEPLOYMENT_ID")) {
  startQueueListener(await getKv());
}

if (import.meta.main) {
  await app.listen();
}
