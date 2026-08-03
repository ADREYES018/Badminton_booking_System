/**
 * A player's own record, and the club leaderboard.
 *
 * Only confirmed matches count, so the numbers here move when the losing side
 * agrees a result and not before.
 *
 * Two presentation rules are deliberate. Players below the qualifying
 * threshold are listed separately rather than dropped — a player who cannot
 * find themselves on a leaderboard, with no explanation, reasonably reads that
 * as a bug. And a show-up rate with nothing recorded renders as a dash, never
 * 0%: an unmarked player has not failed to turn up.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { Avatar, Card, Chip, EmptyState } from "../components/ui.tsx";
import {
  requireMember,
  requireUser,
  resolveGroupAccess,
} from "../lib/auth/middleware.ts";
import { getStats, listStats } from "../lib/data/matches.ts";
import { redirectToGroup } from "../lib/routing/group_redirect.ts";
import { getUser } from "../lib/data/users.ts";
import type { PlayerStats, User } from "../lib/types.ts";

/**
 * Confirmed matches a player needs before they are ranked.
 *
 * A locked decision: a 100% record from a single match tells nobody anything,
 * and would sit above a player who has won twenty of thirty.
 */
export const QUALIFYING_MATCHES = 5;

export interface Ranked {
  stats: PlayerStats;
  user: User | null;
}

export function matchesPlayed(stats: PlayerStats): number {
  return stats.wins + stats.losses;
}

/** Wins as a share of decided matches, or null when none have been played. */
export function winRate(stats: PlayerStats): number | null {
  const played = matchesPlayed(stats);
  return played === 0 ? null : stats.wins / played;
}

/**
 * Turn-ups as a share of games marked either way.
 *
 * Null when nothing has been marked. Reporting that as 0% would count an
 * organizer's unfinished paperwork against the player.
 */
export function showUpRate(stats: PlayerStats): number | null {
  const marked = stats.attended + stats.noShow;
  return marked === 0 ? null : stats.attended / marked;
}

export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/**
 * The leaderboard, best first, and everyone still short of the threshold.
 *
 * Ties break on matches played: between two equal rates, the longer record is
 * the better established one.
 */
export function rank(entries: Ranked[]): {
  ranked: Ranked[];
  qualifying: Ranked[];
} {
  const played = (entry: Ranked) => matchesPlayed(entry.stats);

  const ranked = entries
    .filter((entry) => played(entry) >= QUALIFYING_MATCHES)
    .sort((a, b) =>
      (winRate(b.stats) ?? 0) - (winRate(a.stats) ?? 0) ||
      played(b) - played(a)
    );

  const qualifying = entries
    .filter((entry) => played(entry) > 0 && played(entry) < QUALIFYING_MATCHES)
    .sort((a, b) => played(b) - played(a));

  return { ranked, qualifying };
}

function Figure(props: { label: string; value: string; note?: string }) {
  return (
    <div class="flex flex-col gap-0.5">
      <dt class="text-label-sm text-on-surface-variant">{props.label}</dt>
      <dd class="text-headline-md font-headline text-on-surface">
        {props.value}
      </dd>
      {props.note && (
        <p class="text-label-sm text-on-surface-variant">{props.note}</p>
      )}
    </div>
  );
}

function LeaderRow(
  props: { entry: Ranked; position?: number; isViewer: boolean },
) {
  const { stats, user } = props.entry;
  const name = user?.name ?? "Player";

  return (
    <li
      class={props.isViewer
        ? "flex items-center gap-3 py-3 px-3 -mx-3 rounded-lg bg-primary-container/40"
        : "flex items-center gap-3 py-3"}
    >
      {props.position !== undefined && (
        <span class="text-label-sm font-bold text-on-surface-variant w-6 tabular-nums shrink-0">
          {props.position}
        </span>
      )}
      <Avatar
        name={name}
        userId={stats.userId}
        hasPhoto={user?.hasPhoto}
        size={36}
      />
      <div class="flex flex-col min-w-0 flex-1">
        <span class="text-body-md text-on-surface truncate">{name}</span>
        <span class="text-label-sm text-on-surface-variant">
          {stats.wins}W · {stats.losses}L
        </span>
      </div>
      <span class="text-body-lg font-bold text-on-surface tabular-nums shrink-0">
        {formatRate(winRate(stats))}
      </span>
    </li>
  );
}

interface StatsProps {
  user: User;
  own: PlayerStats;
  ranked: Ranked[];
  qualifying: Ranked[];
  groupSlug: string;
}

function StatsPage(props: StatsProps) {
  const { user, own, ranked, qualifying } = props;
  const played = matchesPlayed(own);

  return (
    <Page user={user} nav="stats" groupSlug={props.groupSlug}>
      <div class="flex flex-col gap-6 max-w-3xl mx-auto">
        <h1 class="text-headline-lg font-headline text-on-surface">Stats</h1>

        <Card accent class="flex flex-col gap-5">
          <div class="flex items-center gap-3">
            <Avatar
              name={user.name || "You"}
              userId={user.id}
              hasPhoto={user.hasPhoto}
              size={44}
            />
            <h2 class="text-body-lg font-bold text-on-surface">Your record</h2>
          </div>

          <dl class="grid grid-cols-3 gap-4">
            <Figure
              label="Win rate"
              value={formatRate(winRate(own))}
              note={`${own.wins}W · ${own.losses}L`}
            />
            <Figure
              label="Show-up rate"
              value={formatRate(showUpRate(own))}
              note={own.attended + own.noShow === 0
                ? "Nothing marked yet"
                : `${own.attended} of ${own.attended + own.noShow}`}
            />
            <Figure label="Matches" value={String(played)} />
          </dl>

          {played < QUALIFYING_MATCHES && (
            <p class="text-label-sm text-on-surface-variant">
              {QUALIFYING_MATCHES - played} more confirmed{" "}
              {QUALIFYING_MATCHES - played === 1 ? "match" : "matches"}{" "}
              and you join the leaderboard.
            </p>
          )}
        </Card>

        <Card class="flex flex-col gap-3">
          <div class="flex items-baseline justify-between gap-3">
            <h2 class="text-body-lg font-bold text-on-surface">Leaderboard</h2>
            <span class="text-label-sm text-on-surface-variant">
              {QUALIFYING_MATCHES}+ confirmed matches
            </span>
          </div>

          {ranked.length > 0
            ? (
              <ul class="flex flex-col divide-y divide-outline-variant">
                {ranked.map((entry, index) => (
                  <LeaderRow
                    key={entry.stats.userId}
                    entry={entry}
                    position={index + 1}
                    isViewer={entry.stats.userId === user.id}
                  />
                ))}
              </ul>
            )
            : (
              <EmptyState title="Nobody has qualified yet">
                Results count once the losing side confirms them. Play{" "}
                {QUALIFYING_MATCHES} and you are on the board.
              </EmptyState>
            )}
        </Card>

        {qualifying.length > 0 && (
          <Card class="flex flex-col gap-3">
            <div class="flex items-baseline gap-2">
              <h2 class="text-body-lg font-bold text-on-surface">
                Still qualifying
              </h2>
              <Chip tone="neutral">{qualifying.length}</Chip>
            </div>
            <p class="text-label-sm text-on-surface-variant">
              Playing, but not yet at {QUALIFYING_MATCHES} confirmed matches.
            </p>
            <ul class="flex flex-col divide-y divide-outline-variant">
              {qualifying.map((entry) => (
                <LeaderRow
                  key={entry.stats.userId}
                  entry={entry}
                  isViewer={entry.stats.userId === user.id}
                />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </Page>
  );
}

export function statsRoute(app: App<State>) {
  app.get("/g/:groupSlug/stats", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    const access = await resolveGroupAccess(
      ctx.state.auth,
      ctx.params.groupSlug!,
    );
    // A leaderboard names the club's players, so it is for the club's players.
    requireMember(access);
    const group = access.group;

    const [own, everyone] = await Promise.all([
      getStats(kv, group.id, user.id),
      listStats(kv, group.id),
    ]);

    const entries: Ranked[] = await Promise.all(
      everyone.map(async (stats) => ({
        stats,
        user: await getUser(kv, stats.userId),
      })),
    );

    const { ranked, qualifying } = rank(entries);

    return await ctx.render(
      <StatsPage
        user={user}
        own={own}
        ranked={ranked}
        qualifying={qualifying}
        groupSlug={group.slug}
      />,
    );
  });

  app.get("/stats", (ctx) => redirectToGroup(ctx, "stats"));
}
