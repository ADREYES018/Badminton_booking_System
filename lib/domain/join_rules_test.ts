import { assertEquals } from "@std/assert";
import {
  canJoin,
  guestsAllowed,
  hasRoom,
  joinBlock,
  skillWarning,
} from "./join_rules.ts";
import type { GameStatus } from "../types.ts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-10T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 4 * HOUR).toISOString();
const EARLIER = new Date(NOW.getTime() - 1 * HOUR).toISOString();

function game(status: GameStatus, startUtc = LATER) {
  return { status, startUtc };
}

Deno.test("an open game in the future may be joined", () => {
  assertEquals(joinBlock(game("open"), NOW), null);
  assertEquals(canJoin(game("open"), NOW), true);
});

Deno.test("a full game is still joinable — the waitlist takes over", () => {
  // Fullness is not a join block. It changes the outcome, not the permission.
  assertEquals(joinBlock(game("full"), NOW), null);
});

Deno.test("a started game is blocked even if seats remain", () => {
  assertEquals(joinBlock(game("open", EARLIER), NOW), "already_started");
});

Deno.test("cancelled, draft and completed games are blocked", () => {
  assertEquals(joinBlock(game("cancelled"), NOW), "cancelled");
  assertEquals(joinBlock(game("draft"), NOW), "not_open");
  assertEquals(joinBlock(game("completed"), NOW), "not_open");
});

Deno.test("joining is blocked exactly at the start instant", () => {
  const startsNow = { status: "open" as const, startUtc: NOW.toISOString() };
  assertEquals(joinBlock(startsNow, NOW), "already_started");
});

Deno.test("skill inside the range produces no warning", () => {
  const warning = skillWarning(
    { skillMin: "beginner", skillMax: "advanced" },
    { skill: "intermediate" },
  );
  assertEquals(warning, null);
});

Deno.test("skill below the range warns but never blocks", () => {
  const warning = skillWarning(
    { skillMin: "advanced", skillMax: undefined },
    { skill: "beginner" },
  );
  assertEquals(typeof warning, "string");
  assertEquals(warning?.includes("still join"), true);
});

Deno.test("skill above the range warns too", () => {
  const warning = skillWarning(
    { skillMin: undefined, skillMax: "beginner" },
    { skill: "competitive" },
  );
  assertEquals(warning?.includes("gentler"), true);
});

Deno.test("a game with no skill range never warns", () => {
  assertEquals(
    skillWarning({ skillMin: undefined, skillMax: undefined }, {
      skill: "beginner",
    }),
    null,
  );
});

Deno.test("guest allowance is capped by the organizer's per-player limit", () => {
  const seats = {
    maxGuestsPerPlayer: 2,
    courts: 2,
    maxPlayers: 16,
    confirmedCount: 4,
    pendingCount: 0,
    guestCount: 0,
  };
  assertEquals(guestsAllowed(seats, 0), 2);
  assertEquals(guestsAllowed(seats, 1), 1);
  assertEquals(guestsAllowed(seats, 2), 0);
});

Deno.test("guest allowance is capped by remaining seats", () => {
  const nearlyFull = {
    maxGuestsPerPlayer: 3,
    courts: 1,
    maxPlayers: 4,
    confirmedCount: 3,
    pendingCount: 0,
    guestCount: 0,
  };
  // Three seats allowed per player, but only one seat left on the court.
  assertEquals(guestsAllowed(nearlyFull, 0), 1);
});

Deno.test("a held seat removes a guest slot", () => {
  const withPending = {
    maxGuestsPerPlayer: 3,
    courts: 1,
    maxPlayers: 4,
    confirmedCount: 2,
    pendingCount: 1,
    guestCount: 0,
  };
  assertEquals(guestsAllowed(withPending, 0), 1);
});

Deno.test("maxGuestsPerPlayer of zero disables guests", () => {
  const noGuests = {
    maxGuestsPerPlayer: 0,
    courts: 2,
    maxPlayers: 16,
    confirmedCount: 0,
    pendingCount: 0,
    guestCount: 0,
  };
  assertEquals(guestsAllowed(noGuests, 0), 0);
});

Deno.test("hasRoom accounts for the seats a party actually needs", () => {
  const seats = {
    courts: 1,
    maxPlayers: 4,
    confirmedCount: 2,
    pendingCount: 0,
    guestCount: 0,
  };
  assertEquals(hasRoom(seats, 1), true);
  assertEquals(hasRoom(seats, 2), true);
  assertEquals(hasRoom(seats, 3), false);
});
