/**
 * How the leaderboard orders players, and what it refuses to claim.
 *
 * The rates are the part worth pinning: a player with nothing marked must not
 * be reported as 0%, because an unmarked player has not failed to turn up. The
 * threshold is the other: a perfect record from one match tells nobody
 * anything.
 */

import { assertEquals } from "@std/assert";
import {
  formatRate,
  QUALIFYING_MATCHES,
  rank,
  type Ranked,
  showUpRate,
  winRate,
} from "./stats.tsx";
import type { PlayerStats } from "../lib/types.ts";

function statsFixture(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    v: 1,
    groupId: "group-1",
    userId: "user-1",
    attended: 0,
    noShow: 0,
    wins: 0,
    losses: 0,
    gamesPlayed: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function entry(userId: string, overrides: Partial<PlayerStats>): Ranked {
  return { stats: statsFixture({ userId, ...overrides }), user: null };
}

Deno.test("a rate with nothing recorded is unknown, not zero", () => {
  assertEquals(winRate(statsFixture()), null);
  assertEquals(showUpRate(statsFixture()), null);
  assertEquals(formatRate(null), "—");
});

Deno.test("an unmarked player is not counted as a no-show", () => {
  // Two games played, neither marked either way.
  const stats = statsFixture({ wins: 1, losses: 1 });
  assertEquals(showUpRate(stats), null);

  // One marked absent, and the rate becomes a real figure.
  assertEquals(showUpRate(statsFixture({ attended: 3, noShow: 1 })), 0.75);
});

Deno.test("win rate counts decided matches only", () => {
  assertEquals(winRate(statsFixture({ wins: 3, losses: 1 })), 0.75);
  assertEquals(
    formatRate(winRate(statsFixture({ wins: 3, losses: 1 }))),
    "75%",
  );
});

Deno.test("only players past the threshold are ranked", () => {
  const { ranked, qualifying } = rank([
    entry("veteran", { wins: 4, losses: 2 }),
    entry("newcomer", { wins: 1, losses: 0 }),
  ]);

  assertEquals(ranked.map((entry) => entry.stats.userId), ["veteran"]);
  // Listed separately rather than dropped: being invisible with no
  // explanation reads as a bug.
  assertEquals(qualifying.map((entry) => entry.stats.userId), ["newcomer"]);
});

Deno.test("a player with no matches at all appears in neither list", () => {
  const { ranked, qualifying } = rank([entry("lurker", {})]);

  assertEquals(ranked.length, 0);
  assertEquals(qualifying.length, 0);
});

Deno.test("the leaderboard is ordered by win rate, best first", () => {
  const { ranked } = rank([
    entry("middling", { wins: 3, losses: 3 }),
    entry("strong", { wins: 5, losses: 1 }),
    entry("weak", { wins: 1, losses: 5 }),
  ]);

  assertEquals(ranked.map((entry) => entry.stats.userId), [
    "strong",
    "middling",
    "weak",
  ]);
});

Deno.test("equal rates break on the longer record", () => {
  const { ranked } = rank([
    entry("shorter", { wins: 3, losses: 3 }),
    entry("longer", { wins: 6, losses: 6 }),
  ]);

  assertEquals(ranked.map((entry) => entry.stats.userId), [
    "longer",
    "shorter",
  ]);
});

Deno.test("the threshold is exactly the qualifying figure, not one past it", () => {
  const { ranked } = rank([
    entry("exact", { wins: QUALIFYING_MATCHES, losses: 0 }),
    entry("oneShort", { wins: QUALIFYING_MATCHES - 1, losses: 0 }),
  ]);

  assertEquals(ranked.map((entry) => entry.stats.userId), ["exact"]);
});
