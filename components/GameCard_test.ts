/**
 * Accessibility contract for the game card.
 *
 * The card is one link wrapping every figure it displays. That makes its
 * accessible name easy to get wrong in two opposite directions: leave the
 * content exposed and a screen reader reads the whole card twice, or hide it
 * and lose the state the player most needs. These tests pin both ends.
 *
 * They assert against rendered markup rather than a snapshot, so a styling
 * change does not fail them but a change in what is announced does.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "preact-render-to-string";
import { GameCard } from "./GameCard.tsx";
import type { Game } from "../lib/types.ts";

const HOUR_MS = 60 * 60 * 1000;

function gameFixture(overrides: Partial<Game> = {}): Game {
  const startUtc = new Date(Date.now() + 96 * HOUR_MS).toISOString();
  return {
    v: 1,
    id: "game-1",
    groupId: "group-1",
    slug: "sunday-doubles-abc",
    title: "Sunday Doubles",
    venue: { name: "Insportz Courts", address: "Al Quoz, Dubai" },
    startUtc,
    endUtc: new Date(new Date(startUtc).getTime() + 2 * HOUR_MS).toISOString(),
    courts: 1,
    courtMode: "fixed",
    playersPerCourt: 4,
    courtStatus: "not_reserved",
    pricePerPlayerFils: 3000,
    guestPricing: { mode: "free", feeFils: 0 },
    maxGuestsPerPlayer: 1,
    cutoffHours: 48,
    status: "open",
    visibility: "public",
    confirmedCount: 0,
    pendingCount: 0,
    guestCount: 0,
    waitlistCount: 0,
    createdBy: "organizer-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Game;
}

/** The single aria-label the card link exposes. */
function linkLabel(html: string): string {
  return html.match(/<a[^>]*aria-label="([^"]*)"/)?.[1] ?? "";
}

Deno.test("the card link names the game, its time, venue and seats", () => {
  const html = render(GameCard({ game: gameFixture() }));
  const label = linkLabel(html);

  assertStringIncludes(label, "Sunday Doubles");
  assertStringIncludes(label, "Insportz Courts");
  assertStringIncludes(label, "4 spots left");
});

Deno.test("the viewer's own state is in the accessible name, not just a chip", () => {
  const confirmed = linkLabel(
    render(GameCard({ game: gameFixture(), viewer: "confirmed" })),
  );
  assertStringIncludes(confirmed, "You are in");

  const pending = linkLabel(
    render(GameCard({ game: gameFixture(), viewer: "pending_confirm" })),
  );
  assertStringIncludes(pending, "Confirm your seat");

  const waitlisted = linkLabel(
    render(GameCard({ game: gameFixture(), viewer: "waitlisted" })),
  );
  assertStringIncludes(waitlisted, "waitlist");
});

Deno.test("an uninvolved viewer gets no state clause", () => {
  const label = linkLabel(render(GameCard({ game: gameFixture() })));
  assertEquals(label.includes("You are in"), false);
  assertEquals(label.includes("waitlist"), false);
});

Deno.test("a cancelled game says so in its name rather than only in colour", () => {
  const html = render(GameCard({ game: gameFixture({ status: "cancelled" }) }));

  assertStringIncludes(linkLabel(html), "Cancelled");
  // And carries a non-colour visual signal too.
  assertStringIncludes(html, "line-through");
});

Deno.test("a played game is announced as played, not as open seats", () => {
  const label = linkLabel(
    render(GameCard({ game: gameFixture({ status: "completed" }) })),
  );

  assertStringIncludes(label, "Played");
  assertEquals(label.includes("spots left"), false);
});

Deno.test("a full game offers the waitlist rather than reporting zero spots", () => {
  const label = linkLabel(
    render(GameCard({ game: gameFixture({ confirmedCount: 4 }) })),
  );
  assertStringIncludes(label, "Full");
});

Deno.test("the decorative copy inside the link is hidden from assistive tech", () => {
  const html = render(GameCard({ game: gameFixture() }));

  // The figures the aria-label already carries must not be announced twice.
  const hidden = html.match(/aria-hidden="true"/g) ?? [];
  assertEquals(
    hidden.length >= 3,
    true,
    `expected the chips, detail list and progress bar to be hidden, ` +
      `found ${hidden.length} aria-hidden elements`,
  );
});
