/**
 * Games list.
 *
 * Phase 1 establishes the shell and the signed-in surface; game records, RSVP
 * and the waitlist arrive in Phase 2, so this currently renders the empty
 * state.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { Alert, EmptyState } from "../components/ui.tsx";
import { requireUser } from "../lib/auth/middleware.ts";
import { isProfileComplete } from "../lib/data/users.ts";

export function gamesRoute(app: App<State>) {
  app.get("/games", (ctx) => {
    const user = requireUser(ctx.state.auth);

    // A player without a name or phone cannot be put on a roster.
    if (!isProfileComplete(user)) return ctx.redirect("/profile/setup");

    return ctx.render(
      <Page user={user} nav="games">
        <div class="flex flex-col gap-6">
          <h1 class="text-headline-lg text-on-surface">Upcoming games</h1>

          <Alert tone="info">
            You are signed in as{" "}
            {user.email}. Games, RSVP and the waitlist land in the next phase.
          </Alert>

          <EmptyState title="No games yet">
            <p>
              Once an organizer creates a game it will appear here with its
              venue, cost and remaining spots.
            </p>
          </EmptyState>
        </div>
      </Page>,
    );
  });
}
