/**
 * A club's games.
 *
 * Two sections: games the player is already part of, then everything else
 * that is open. Splitting them means the answer to "what have I got on?" does
 * not have to be picked out of a list of everything.
 *
 * The club is named in the URL, so a link pasted into a chat resolves to the
 * same club for everyone who opens it. A signed-in non-member still sees the
 * public games — a club is private in who may play, not in whether it exists —
 * but every control that would commit them to a game is replaced by the way in.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { Alert, EmptyState, LinkButton } from "../components/ui.tsx";
import { GameCard, viewerStateOf } from "../components/GameCard.tsx";
import { requireUser, resolveGroupAccess } from "../lib/auth/middleware.ts";
import { isProfileComplete } from "../lib/data/users.ts";
import { listOpenGames } from "../lib/data/games.ts";
import { getSignup } from "../lib/data/signups.ts";
import { getJoinRequest } from "../lib/data/groups.ts";
import { redirectToGroup } from "../lib/routing/group_redirect.ts";
import { sweepInBackground } from "../lib/data/sweep.ts";
import type { Game, Group, JoinRequest, Signup, User } from "../lib/types.ts";

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

/** What a signed-in non-member is offered instead of a roster. */
function JoinPrompt(props: { group: Group; request: JoinRequest | null }) {
  if (props.request?.status === "pending") {
    return (
      <Alert tone="info">
        Your request to join {props.group.name} is with the organizers.
      </Alert>
    );
  }

  return (
    <Alert tone="info">
      <div class="flex flex-col gap-3">
        <p>
          You are not in {props.group.name}{" "}
          yet, so you cannot sign up for these games. Ask an organizer for an
          invite link, or request a place.
        </p>
        <LinkButton
          href={`/g/${props.group.slug}/request`}
          variant="primary"
          class="w-fit"
        >
          Request to join
        </LinkButton>
      </div>
    </Alert>
  );
}

export function gamesRoute(app: App<State>) {
  app.get("/g/:groupSlug/games", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    // A player without a name or phone cannot be put on a roster.
    if (!isProfileComplete(user)) return ctx.redirect("/profile/setup");

    const access = await resolveGroupAccess(
      ctx.state.auth,
      ctx.params
        .groupSlug!,
    );
    const group = access.group;
    const games = await listOpenGames(kv, group.id);

    // A non-member has no signups here by definition, so the lookup is skipped
    // rather than run once per game to return null every time.
    const entries: Listed[] = access.membership || access.isOrganizer
      ? await Promise.all(
        games.map(async (game) => ({
          game,
          signup: await getSignup(kv, game.id, user.id),
        })),
      )
      : games.map((game) => ({ game, signup: null }));

    // Correct anything the queue missed — an overdue freeze, a lapsed offer.
    // Fire-and-forget: this page renders from what was already read.
    for (const entry of entries) sweepInBackground(kv, entry.game);

    const request = access.membership
      ? null
      : await getJoinRequest(kv, group.id, user.id);

    const mine = entries.filter(isMine);
    const rest = entries.filter((entry) => !isMine(entry));
    const url = new URL(ctx.req.url);

    return ctx.render(
      <Page user={user} nav="games" groupSlug={group.slug}>
        <div class="flex flex-col gap-8">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h1 class="text-headline-lg font-headline text-on-surface">
                {group.name}
              </h1>
              <p class="text-body-md text-on-surface-variant mt-1">
                Upcoming games
              </p>
            </div>
            {access.isOrganizer && (
              <div class="flex items-center gap-3">
                <a
                  href={`/g/${group.slug}/members`}
                  class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors"
                >
                  Members
                </a>
                <LinkButton
                  href={`/g/${group.slug}/organizer/games/new`}
                  variant="primary"
                >
                  New game
                </LinkButton>
              </div>
            )}
          </div>

          {url.searchParams.get("joined") && (
            <Alert tone="success">You are in. Pick a game below.</Alert>
          )}

          {!access.membership && <JoinPrompt group={group} request={request} />}

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
              {access.isOrganizer && (
                <div class="mt-6 flex justify-center">
                  <LinkButton href={`/g/${group.slug}/organizer/games/new`}>
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

  // Kept so links and bookmarks from before clubs had URLs still work, and so
  // the bottom navigation can stay club-agnostic.
  app.get("/games", (ctx) => redirectToGroup(ctx, "games"));
}
