import { assertEquals } from "@std/assert";
import {
  aedToFils,
  amountOwed,
  capacityOf,
  currentSplit,
  displaySplit,
  formatFils,
  seatsRemaining,
  splitCost,
} from "./money.ts";
import type { GuestPricing } from "../types.ts";

const fullShare: GuestPricing = { mode: "full_share", feeFils: 0 };
const free: GuestPricing = { mode: "free", feeFils: 0 };
const flat40: GuestPricing = { mode: "flat_fee", feeFils: 4000 };

Deno.test("aedToFils avoids float drift", () => {
  assertEquals(aedToFils(35), 3500);
  assertEquals(aedToFils(35.5), 3550);
  // 0.1 + 0.2 style errors must not survive the conversion.
  assertEquals(aedToFils(0.1 + 0.2), 30);
});

Deno.test("formatFils drops trailing zeroes but keeps real fils", () => {
  assertEquals(formatFils(3500), "AED 35");
  assertEquals(formatFils(3550), "AED 35.50");
  assertEquals(formatFils(3505), "AED 35.05");
  assertEquals(formatFils(0), "AED 0");
  assertEquals(formatFils(-3500), "-AED 35");
});

Deno.test("splitCost divides evenly when it can", () => {
  const split = splitCost(56000, 16, 0, fullShare);
  assertEquals(split.perHeadFils, 3500);
  assertEquals(split.totalCollectedFils, 56000);
});

Deno.test("splitCost rounds up so the organizer is never short", () => {
  // 350 AED across 16 players is 21.875 each.
  const split = splitCost(35000, 16, 0, fullShare);
  assertEquals(split.perHeadFils, 2188);
  // Collecting slightly more than the cost is the intended trade-off.
  assertEquals(split.totalCollectedFils >= 35000, true);
  assertEquals(split.totalCollectedFils - 35000, 8);
});

Deno.test("full_share counts guests in the divisor", () => {
  const split = splitCost(60000, 10, 2, fullShare);
  assertEquals(split.perHeadFils, 5000);
  assertEquals(split.perGuestFils, 5000);
});

Deno.test("free mode excludes guests and members absorb the cost", () => {
  const withoutGuests = splitCost(60000, 10, 0, free);
  const withGuests = splitCost(60000, 10, 2, free);
  assertEquals(withGuests.perGuestFils, 0);
  // Guests change nothing for members under this mode.
  assertEquals(withGuests.perHeadFils, withoutGuests.perHeadFils);
  assertEquals(withGuests.perHeadFils, 6000);
});

Deno.test("flat_fee deducts guest fees from the pot before splitting", () => {
  // 600 AED total, two guests at 40 each leaves 520 across 10 members.
  const split = splitCost(60000, 10, 2, flat40);
  assertEquals(split.perGuestFils, 4000);
  assertEquals(split.perHeadFils, 5200);
  assertEquals(split.totalCollectedFils, 60000);
});

Deno.test("flat_fee never drives member share below zero", () => {
  // Guests over-cover the whole cost.
  const split = splitCost(5000, 4, 3, flat40);
  assertEquals(split.perHeadFils, 0);
  assertEquals(split.perGuestFils, 4000);
});

Deno.test("splitCost with no confirmed players owes nothing", () => {
  const split = splitCost(60000, 0, 0, fullShare);
  assertEquals(split.perHeadFils, 0);
  assertEquals(split.totalCollectedFils, 0);
});

Deno.test("amountOwed adds each guest's share to the inviter", () => {
  const split = splitCost(60000, 10, 2, flat40);
  const withTwo = amountOwed({ guests: [g("a"), g("b")] }, split);
  // 52 for the member plus 40 per guest.
  assertEquals(withTwo, 5200 + 4000 * 2);
  assertEquals(amountOwed({ guests: [] }, split), 5200);
});

Deno.test("capacity and remaining seats account for guests", () => {
  const game = {
    courts: 2,
    playersPerCourt: 8,
    confirmedCount: 12,
    pendingCount: 0,
    guestCount: 2,
  };
  assertEquals(capacityOf(game), 16);
  assertEquals(seatsRemaining(game), 2);
});

Deno.test("seatsRemaining never goes negative", () => {
  const game = {
    courts: 1,
    playersPerCourt: 4,
    confirmedCount: 4,
    pendingCount: 0,
    guestCount: 2,
  };
  assertEquals(seatsRemaining(game), 0);
});

Deno.test("an empty game is quoted as if you joined alone, not as free", () => {
  const game = {
    totalCostFils: 12000,
    confirmedCount: 0,
    pendingCount: 0,
    guestCount: 0,
    guestPricing: { mode: "free" as const, feeFils: 0 },
    frozenPerHeadFils: undefined,
  } as Parameters<typeof displaySplit>[0];

  // currentSplit correctly says nobody owes anything...
  assertEquals(currentSplit(game).perHeadFils, 0);
  // ...but showing "AED 0" would read as free, when the first player in
  // actually covers the whole court.
  assertEquals(displaySplit(game).perHeadFils, 12000);
});

Deno.test("displaySplit defers to the real split once anyone has joined", () => {
  const game = {
    totalCostFils: 12000,
    confirmedCount: 4,
    pendingCount: 0,
    guestCount: 0,
    guestPricing: { mode: "free" as const, feeFils: 0 },
    frozenPerHeadFils: undefined,
  } as Parameters<typeof displaySplit>[0];

  assertEquals(displaySplit(game).perHeadFils, 3000);
});

Deno.test("displaySplit never overrides a frozen figure", () => {
  const game = {
    totalCostFils: 12000,
    confirmedCount: 0,
    pendingCount: 0,
    guestCount: 0,
    guestPricing: { mode: "free" as const, feeFils: 0 },
    frozenPerHeadFils: 2500,
  } as Parameters<typeof displaySplit>[0];

  // A frozen game with an empty roster is a real, if unusual, state — the
  // locked figure is what everyone owes and must not be recomputed.
  assertEquals(displaySplit(game).perHeadFils, 2500);
});

Deno.test("a held seat blocks a join but is not billed", () => {
  const seats = {
    courts: 1,
    playersPerCourt: 4,
    confirmedCount: 3,
    pendingCount: 1,
    guestCount: 0,
  };
  // The promoted player's unaccepted seat fills the court.
  assertEquals(seatsRemaining(seats), 0);

  // But the three who actually hold seats split the cost between three, not
  // four. If the offer expires, nobody's share has to be recalculated.
  const split = splitCost(9000, seats.confirmedCount, seats.guestCount, {
    mode: "free",
    feeFils: 0,
  });
  assertEquals(split.perHeadFils, 3000);
});

function g(id: string) {
  return { id, name: `Guest ${id}` };
}
