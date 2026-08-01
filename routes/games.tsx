/**
 * Games list.
 *
 * Two sections: games the player is already part of, then everything else
 * that is open. Splitting them means the answer to "what have I got on?" does
 * not have to be picked out of a list of everything.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { EmptyState, LinkButton } from "../components/ui.tsx";
import { GameCard, viewerStateOf } from "../components/GameCard.tsx";
import { requireUser } from "../lib/auth/middleware.ts";
import { isProfileComplete } from "../lib/data/users.ts";
import { listOpenGames } from "../lib/data/games.ts";
import { getSignup } from "../lib/data/signups.ts";
import { ensureDefaultGroup, ensureMembership } from "../lib/data/groups.ts";
import { sweepInBackground } from "../lib/data/sweep.ts";
import type { Game, Signup, User } from "../lib/types.ts";

interface Listed {
  game: Game;
  signup: Signup | null;
}

function isMine(entry: Listed): boolean {
  const status = entry.signup?.status;
  return status === "confirmed" || status === "pending_confirm" ||
    status === "waitlisted";
}

function Section(
  props: { title: string; entries: Listed[]; description?: string },
) {
  if (props.entries.length === 0) return null;
  return (
    <section class="flex flex-col gap-4">
      <div>
        <h2 class="text-headline-md font-headline text-on-surface">
          {props.title}
        </h2>
        {props.description && (
          <p class="text-body-md text-on-surface-variant mt-1">
            {props.description}
          </p>
        )}
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        {props.entries.map((entry) => (
          <GameCard
            key={entry.game.id}
            game={entry.game}
            viewer={viewerStateOf(entry.signup)}
          />
        ))}
      </div>
    </section>
  );
}

function canOrganize(user: User): boolean {
  return user.role === "super_admin" || user.role === "organizer";
}

export function gamesRoute(app: App<State>) {
  app.get("/games", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    // A player without a name or phone cannot be put on a roster.
    if (!isProfileComplete(user)) return ctx.redirect("/profile/setup");

    // Phase 2 runs a single club, joined on first visit.
    const group = await ensureDefaultGroup(kv, user.id);
    await ensureMembership(
      kv,
      group.id,
      user.id,
      canOrganize(user) ? "organizer" : "player",
    );

    const games = await listOpenGames(kv);

    const entries: Listed[] = await Promise.all(
      games.map(async (game) => ({
        game,
        signup: await getSignup(kv, game.id, user.id),
      })),
    );

    // Correct anything the queue missed — an overdue freeze, a lapsed offer.
    // Fire-and-forget: this page renders from what was already read.
    for (const entry of entries) sweepInBackground(kv, entry.game);

    const mine = entries.filter(isMine);
    const rest = entries.filter((entry) => !isMine(entry));

    return ctx.render(
      <Page user={user} nav="games">
        <div class="flex flex-col gap-8">
          <div class="flex items-start justify-between gap-4">
            <h1 class="text-headline-lg font-headline text-on-surface">
              Upcoming games
            </h1>
            {canOrganize(user) && (
              <LinkButton href="/organizer/games/new" variant="primary">
                New game
              </LinkButton>
            )}
          </div>

          <Section
            title="Your games"
            entries={mine}
            description="Games you have joined or are waiting on."
          />

          <Section
            title={mine.length > 0 ? "Other games" : "Open games"}
            entries={rest}
          />

          {entries.length === 0 && (
            <EmptyState title="No games yet">
              <p>
                Once an organizer posts a game it will appear here with its
                venue, cost and remaining spots.
              </p>
              {canOrganize(user) && (
                <div class="mt-6 flex justify-center">
                  <LinkButton href="/organizer/games/new">
                    Post the first game
                  </LinkButton>
                </div>
              )}
            </EmptyState>
          )}
        </div>
      </Page>,
    );
  });
}
