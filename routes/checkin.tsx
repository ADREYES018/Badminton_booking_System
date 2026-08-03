/**
 * The door screen.
 *
 * For an organizer: the scanner, and directly beneath it the confirmed roster
 * with the manual toggles from Phase 4. Scanning handles most of a queue and
 * the toggles handle whoever's phone is flat, so the organizer never has to
 * leave this page to fix a miss.
 *
 * For a player: their one permanent code, and the games it is currently good
 * for.
 *
 * The bottom nav has linked here since Phase 1 and it has been a 404 since.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import {
  Alert,
  Avatar,
  Card,
  EmptyState,
  LinkButton,
} from "../components/ui.tsx";
import {
  AttendanceChip,
  AttendanceToggle,
  presentCount,
} from "../components/Attendance.tsx";
import { CheckinCode } from "../components/CheckinCode.tsx";
import CheckinScanner from "../islands/CheckinScanner.tsx";
import {
  CSRF_FIELD,
  csrfCookie,
  isSecureRequest,
  requireMember,
  requireUser,
  resolveGroupAccess,
} from "../lib/auth/middleware.ts";
import { listGamesByGroup } from "../lib/data/games.ts";
import { getSignup, listRoster } from "../lib/data/signups.ts";
import { getUser } from "../lib/data/users.ts";
import { redirectToGroup } from "../lib/routing/group_redirect.ts";
import { checkinVersionOf, mintCheckinToken } from "../lib/domain/checkin.ts";
import { formatGameTime, isPastCutoff } from "../lib/domain/time.ts";
import type { VNode } from "preact";
import type { Game, Signup, User } from "../lib/types.ts";

/** A game is ready to check into once its roster has closed. */
function isOpenForCheckin(game: Game): boolean {
  return game.status !== "cancelled" &&
    isPastCutoff(game.startUtc, game.cutoffHours);
}

interface RosterRow {
  signup: Signup;
  user: User | null;
}

interface OrganizerProps {
  user: User;
  game: Game;
  rows: RosterRow[];
  csrf: string;
}

function OrganizerView(props: OrganizerProps) {
  const { game, rows, csrf } = props;
  const present = presentCount(rows.map((row) => row.signup));

  return (
    <div class="flex flex-col gap-6 max-w-3xl mx-auto">
      <header class="flex flex-col gap-1">
        <h1 class="text-headline-lg font-headline text-on-surface">Check in</h1>
        <p class="text-body-md text-on-surface-variant">
          {game.title} · {formatGameTime(game.startUtc, game.endUtc)}
        </p>
      </header>

      <Card class="flex flex-col gap-4">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="text-body-lg font-bold text-on-surface">Scanner</h2>
          <span class="text-label-sm text-on-surface-variant tabular-nums">
            {present} of {rows.length} in
          </span>
        </div>

        <CheckinScanner
          slug={game.slug}
          csrf={csrf}
          csrfField={CSRF_FIELD}
        />
      </Card>

      <Card class="flex flex-col gap-3">
        <h2 class="text-body-lg font-bold text-on-surface">
          Mark someone manually
        </h2>
        <p class="text-label-sm text-on-surface-variant">
          For anyone whose phone is flat, or who never got scanned.
        </p>

        <ul class="flex flex-col divide-y divide-outline-variant">
          {rows.map(({ signup, user }) => (
            <li
              key={signup.userId}
              class="flex flex-wrap items-center gap-3 py-3"
            >
              <Avatar
                name={user?.name ?? "Player"}
                userId={signup.userId}
                hasPhoto={user?.hasPhoto}
                size={36}
              />
              <span class="text-body-md text-on-surface flex-1 min-w-0 truncate">
                {user?.name ?? "Player"}
              </span>
              <AttendanceChip signup={signup} />
              <AttendanceToggle
                signup={signup}
                slug={game.slug}
                csrf={csrf}
                csrfField={CSRF_FIELD}
                name={user?.name ?? "this player"}
              />
            </li>
          ))}
        </ul>

        {rows.length === 0 && (
          <p class="text-body-md text-on-surface-variant text-center py-4">
            Nobody is on the confirmed roster.
          </p>
        )}
      </Card>
    </div>
  );
}

interface PlayerProps {
  user: User;
  token: string;
  games: Game[];
}

function PlayerView(props: PlayerProps) {
  return (
    <div class="flex flex-col gap-6 max-w-3xl mx-auto">
      <h1 class="text-headline-lg font-headline text-on-surface">Check in</h1>

      <CheckinCode token={props.token} />

      {props.games.length === 0
        ? (
          <EmptyState title="Nothing to check into yet">
            Your code still works. Games appear here once their rosters close.
          </EmptyState>
        )
        : (
          <Card class="flex flex-col gap-3">
            <h2 class="text-body-lg font-bold text-on-surface">
              Ready to check into
            </h2>
            <ul class="flex flex-col divide-y divide-outline-variant">
              {props.games.map((game) => (
                <li key={game.id} class="flex flex-col gap-0.5 py-3">
                  <a
                    href={`/games/${game.slug}`}
                    class="text-body-md font-bold text-on-surface hover:text-primary transition-colors"
                  >
                    {game.title}
                  </a>
                  <p class="text-label-sm text-on-surface-variant">
                    {formatGameTime(game.startUtc, game.endUtc)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
    </div>
  );
}

function NoGameView() {
  return (
    <div class="flex flex-col gap-6 max-w-3xl mx-auto">
      <h1 class="text-headline-lg font-headline text-on-surface">Check in</h1>
      <Alert tone="info">
        No game has closed its roster yet. Check-in opens at the cutoff.
      </Alert>
      <LinkButton href="/games" variant="secondary" class="w-fit">
        See the games
      </LinkButton>
    </div>
  );
}

export function checkinRoute(app: App<State>) {
  app.get("/g/:groupSlug/checkin", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    const access = await resolveGroupAccess(
      ctx.state.auth,
      ctx.params.groupSlug!,
    );
    // Check-in shows a player their own code or an organizer the roster, so
    // there is nothing here for someone outside the club.
    requireMember(access);
    const group = access.group;

    const render = async (node: VNode) => {
      const response = await ctx.render(node);
      response.headers.append(
        "set-cookie",
        csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
      );
      return response;
    };

    if (access.isOrganizer) {
      // The game being played now, or the most recent one to have closed.
      const games = await listGamesByGroup(kv, group.id);
      const open = games
        .filter(isOpenForCheckin)
        .sort((a, b) => b.startUtc.localeCompare(a.startUtc));
      const game = open[0];

      if (!game) {
        return await render(
          <Page user={user} nav="checkin" groupSlug={group.slug}>
            <NoGameView />
          </Page>,
        );
      }

      const confirmed = await listRoster(kv, game.id, "confirmed");
      const rows: RosterRow[] = await Promise.all(
        confirmed.map(async (signup) => ({
          signup,
          user: await getUser(kv, signup.userId),
        })),
      );

      return await render(
        <Page user={user} nav="checkin" groupSlug={group.slug}>
          <OrganizerView
            user={user}
            game={game}
            rows={rows}
            csrf={ctx.state.auth.csrfToken}
          />
        </Page>,
      );
    }

    // `listUserSignups` indexes forward from now, so a game whose cutoff has
    // passed is already behind its cursor — exactly the games check-in is for.
    // The group's own list is the one that still contains them.
    const games = (await listGamesByGroup(kv, group.id))
      .filter(isOpenForCheckin)
      .sort((a, b) => b.startUtc.localeCompare(a.startUtc));

    // Only the games this player is actually on, so the list matches what the
    // scanner will accept.
    const mine: Game[] = [];
    for (const game of games) {
      const signup = await getSignup(kv, game.id, user.id);
      if (signup?.status === "confirmed") mine.push(game);
    }

    // One code, whatever is on the list. It does not depend on the games.
    const token = await mintCheckinToken(user.id, checkinVersionOf(user));

    return await render(
      <Page user={user} nav="checkin" groupSlug={group.slug}>
        <PlayerView user={user} token={token} games={mine} />
      </Page>,
    );
  });

  app.get("/checkin", (ctx) => redirectToGroup(ctx, "checkin"));
}
