/**
 * Games, listed two ways: everything everywhere at `/games`, and one club's
 * own at `/g/:slug/games`.
 *
 * Both split into games the player is already part of and everything else, so
 * the answer to "what have I got on?" does not have to be picked out of a list
 * of everything.
 *
 * The global list is the one the app opens on. Membership no longer gates
 * playing, so a club page is a view of who organizes what rather than a door,
 * and it survives because a link pasted into a chat should still resolve to
 * the club it names.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import {
  Alert,
  Button,
  cx,
  EmptyState,
  LinkButton,
} from "../components/ui.tsx";
import { GameCard, SportIcon, viewerStateOf } from "../components/GameCard.tsx";
import { requireUser, resolveGroupAccess } from "../lib/auth/middleware.ts";
import { isProfileComplete } from "../lib/data/users.ts";
import { listAllOpenGames, listOpenGames } from "../lib/data/games.ts";
import { getSignup } from "../lib/data/signups.ts";
import { listGroupsOrganizedBy } from "../lib/data/groups.ts";
import { sweepInBackground } from "../lib/data/sweep.ts";
import { isSport, SPORT_LABELS, SPORTS } from "../lib/types.ts";
import type { Game, Signup, Sport } from "../lib/types.ts";
import SpotCancelledDialog from "../islands/SpotCancelledDialog.tsx";

interface Listed {
  game: Game;
  signup: Signup | null;
}

function isMine(entry: Listed): boolean {
  const status = entry.signup?.status;
  return status === "confirmed" || status === "pending_confirm" ||
    status === "waitlisted";
}

/** What the viewer narrowed the list to, read off the query string. */
interface Filters {
  sport: Sport | null;
  query: string;
}

function filtersFrom(url: URL): Filters {
  const sportRaw = url.searchParams.get("sport") ?? "";
  return {
    sport: isSport(sportRaw) ? sportRaw : null,
    query: (url.searchParams.get("q") ?? "").trim(),
  };
}

/**
 * Applies the sport filter and the search box.
 *
 * Filtering happens here rather than in KV: the listing is a bounded range
 * read of upcoming games, so it is already in memory, and a per-sport index
 * would be a second thing to keep in step with `games_all` for no gain at this
 * size.
 *
 * The search covers title and venue — both name and address — because "where
 * is there a game" and "what is the game called" are the same question asked
 * two ways, and a player who remembers only "Al Quoz" should find it.
 */
function applyFilters(entries: Listed[], filters: Filters): Listed[] {
  const needle = filters.query.toLowerCase();

  return entries.filter(({ game }) => {
    if (filters.sport && game.sport !== filters.sport) return false;
    if (!needle) return true;

    return [game.title, game.venue.name, game.venue.address]
      .some((field) => field.toLowerCase().includes(needle));
  });
}

/**
 * The search box and the sport chips.
 *
 * A plain GET form, so it works with scripting off and every result is a URL
 * that can be shared or bookmarked. The chips are links rather than inputs for
 * the same reason: one tap, no submit, and the current filter is visible in
 * the address bar.
 */
function FilterBar(
  props: { filters: Filters; action: string; total: number; shown: number },
) {
  const { filters } = props;

  // Each chip keeps whatever text is in the search box, so narrowing by sport
  // does not throw away a search the player just typed.
  const href = (sport: Sport | null) => {
    const params = new URLSearchParams();
    if (sport) params.set("sport", sport);
    if (filters.query) params.set("q", filters.query);
    const query = params.toString();
    return query ? `${props.action}?${query}` : props.action;
  };

  const chip = (sport: Sport | null, label: string) => {
    const active = filters.sport === sport;
    return (
      <a
        key={label}
        href={href(sport)}
        aria-current={active ? "true" : undefined}
        class={cx(
          "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-label font-bold no-underline transition-colors",
          active
            ? "bg-primary text-on-primary"
            : "bg-surface-container text-on-surface-variant hover:text-primary",
        )}
      >
        {sport && <SportIcon sport={sport} size={16} />}
        {label}
      </a>
    );
  };

  return (
    <div class="flex flex-col gap-3">
      <form method="get" action={props.action} class="flex gap-2">
        {/* Carried through the search so submitting keeps the chosen sport. */}
        {filters.sport && (
          <input type="hidden" name="sport" value={filters.sport} />
        )}
        <input
          type="search"
          name="q"
          value={filters.query}
          placeholder="Search by title or venue"
          aria-label="Search games by title or venue"
          class="flex-1 min-w-0 rounded-full bg-surface-container px-5 py-3 text-body-md
                 text-on-surface placeholder:text-on-surface-variant
                 focus-visible:outline-2 focus-visible:outline-primary"
        />
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      <div class="flex flex-wrap gap-2">
        {chip(null, "All sports")}
        {SPORTS.map((sport) => chip(sport, SPORT_LABELS[sport]))}
      </div>

      {(filters.sport || filters.query) && (
        <p class="text-label-sm text-on-surface-variant">
          {props.shown === 0
            ? "Nothing matches that."
            : `Showing ${props.shown} of ${props.total} games.`}{" "}
          <a href={props.action} class="text-primary hover:underline">
            Clear filters
          </a>
        </p>
      )}
    </div>
  );
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
    const all: Listed[] = access.membership || access.isOrganizer
      ? await Promise.all(
        games.map(async (game) => ({
          game,
          signup: await getSignup(kv, game.id, user.id),
        })),
      )
      : games.map((game) => ({ game, signup: null }));

    // Correct anything the queue missed — an overdue freeze, a lapsed offer.
    // Fire-and-forget: this page renders from what was already read.
    for (const entry of all) sweepInBackground(kv, entry.game);

    const url = new URL(ctx.req.url);
    const filters = filtersFrom(url);
    const entries = applyFilters(all, filters);

    const mine = entries.filter(isMine);
    const rest = entries.filter((entry) => !isMine(entry));

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
          {url.searchParams.get("notice") && (
            <Alert tone="success">{url.searchParams.get("notice")}</Alert>
          )}

          <FilterBar
            filters={filters}
            action={`/g/${group.slug}/games`}
            total={all.length}
            shown={entries.length}
          />

          <Section
            title="Your games"
            entries={mine}
            description="Games you have joined or are waiting on."
          />

          <Section
            title={mine.length > 0 ? "Other games" : "Open games"}
            entries={rest}
          />

          {entries.length === 0 && all.length > 0 && (
            <EmptyState title="No games match">
              <p>
                Nothing here fits that search. Try another sport, or clear the
                filters to see everything on at this club.
              </p>
              <div class="mt-6 flex justify-center">
                <LinkButton href={`/g/${group.slug}/games`}>
                  Clear filters
                </LinkButton>
              </div>
            </EmptyState>
          )}

          {all.length === 0 && (
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

  /**
   * Every open game, across every club.
   *
   * What the app opens on. Games used to be reachable only inside a club the
   * viewer had joined, which meant a new player's first screen was a request
   * to be let in somewhere. Listing them all means there is always something
   * to join, and the club a game belongs to is a detail on the card rather
   * than a gate in front of it.
   */
  app.get("/games", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    if (!isProfileComplete(user)) return ctx.redirect("/profile/setup");

    // Posting no longer needs a club to aim at: `/games/new` creates a game
    // that belongs to whoever posts it. An organizer's own club is still the
    // better destination when they have one, since a game posted there reaches
    // that club's members and its settlement screen.
    const organizing = await listGroupsOrganizedBy(kv, user.id);
    const newGameHref = organizing[0]
      ? `/g/${organizing[0].slug}/organizer/games/new`
      : "/games/new";

    const games = await listAllOpenGames(kv);
    const all: Listed[] = await Promise.all(
      games.map(async (game) => ({
        game,
        signup: await getSignup(kv, game.id, user.id),
      })),
    );

    for (const entry of all) sweepInBackground(kv, entry.game);

    const url = new URL(ctx.req.url);
    const filters = filtersFrom(url);
    const entries = applyFilters(all, filters);

    const mine = entries.filter(isMine);
    const rest = entries.filter((entry) => !isMine(entry));

    return ctx.render(
      <Page user={user} nav="games">
        <div class="flex flex-col gap-8">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h1 class="text-headline-lg font-headline text-on-surface">
                Games
              </h1>
              <p class="text-body-md text-on-surface-variant mt-1">
                Everything coming up. Join any of them.
              </p>
            </div>
            <LinkButton href={newGameHref} variant="primary">
              New game
            </LinkButton>
          </div>

          {url.searchParams.get("notice") && (
            <Alert tone="success">{url.searchParams.get("notice")}</Alert>
          )}

          {
            /* Raised by the redirect out of a cancellation, which lands here
              rather than on the game the player just left. */
          }
          {url.searchParams.get("cancelled") && (
            <SpotCancelledDialog
              title={url.searchParams.get("cancelled")!}
              owed={url.searchParams.get("owed") === "1"}
            />
          )}

          <FilterBar
            filters={filters}
            action="/games"
            total={all.length}
            shown={entries.length}
          />

          <Section
            title="Your games"
            entries={mine}
            description="Games you have joined or are waiting on."
          />

          <Section
            title={mine.length > 0 ? "Other games" : "Open games"}
            entries={rest}
          />

          {
            /* Two different emptinesses: a filter that matched nothing is the
               viewer's own doing and needs the filter cleared, not an invitation
               to post the first game. */
          }
          {entries.length === 0 && all.length > 0 && (
            <EmptyState title="No games match">
              <p>
                Nothing here fits that search. Try another sport, or clear the
                filters to see everything coming up.
              </p>
              <div class="mt-6 flex justify-center">
                <LinkButton href="/games">Clear filters</LinkButton>
              </div>
            </EmptyState>
          )}

          {all.length === 0 && (
            <EmptyState title="No games yet">
              <p>
                Nothing is on. Post the first one and it will show up here with
                its venue, cost and remaining spots.
              </p>
              <div class="mt-6 flex justify-center">
                <LinkButton href={newGameHref}>Post a game</LinkButton>
              </div>
            </EmptyState>
          )}
        </div>
      </Page>,
    );
  });
}
