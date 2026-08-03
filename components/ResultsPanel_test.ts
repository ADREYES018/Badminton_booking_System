/**
 * Who may rule on a reported result.
 *
 * This is the one rule the results UI is responsible for expressing: a result
 * counts only when the loser agrees, so only the losing side is offered the
 * confirm and dispute controls. The backend enforces it too — these tests pin
 * the courtesy, not the control.
 *
 * They assert against the predicate rather than rendered markup, because the
 * question is which side won, not how a button is styled.
 */

import { assertEquals } from "@std/assert";
import { canRuleOn, losingSide } from "./ResultsPanel.tsx";
import type { Match } from "../lib/types.ts";

function matchFixture(overrides: Partial<Match> = {}): Match {
  return {
    v: 1,
    id: "match-1",
    gameId: "game-1",
    groupId: "group-1",
    sideA: ["a1", "a2"],
    sideB: ["b1", "b2"],
    scoreA: 21,
    scoreB: 15,
    status: "pending",
    reportedBy: "a1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

Deno.test("the losing side is whichever side scored fewer, either way round", () => {
  assertEquals(losingSide(matchFixture()), ["b1", "b2"]);
  assertEquals(
    losingSide(matchFixture({ scoreA: 15, scoreB: 21 })),
    ["a1", "a2"],
  );
});

Deno.test("only the losing side is offered the confirm and dispute controls", () => {
  const match = matchFixture();

  assertEquals(canRuleOn(match, "b1"), true);
  assertEquals(canRuleOn(match, "b2"), true);

  // The winner reporting and confirming their own victory would make the
  // pending state decorative.
  assertEquals(canRuleOn(match, "a1"), false);
  assertEquals(canRuleOn(match, "a2"), false);
});

Deno.test("someone who did not play is offered nothing", () => {
  assertEquals(canRuleOn(matchFixture(), "stranger"), false);
});

Deno.test("a settled result offers no further action to anyone", () => {
  for (const status of ["confirmed", "rejected"] as const) {
    const match = matchFixture({ status });
    assertEquals(canRuleOn(match, "b1"), false, `${status} still offered`);
  }
});
