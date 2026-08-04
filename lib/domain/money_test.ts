import { assertEquals } from "@std/assert";
import {
  aedToFils,
  amountOwed,
  capacityOf,
  expectedTakeFils,
  formatFils,
  seatsRemaining,
} from "./money.ts";

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

Deno.test("amountOwed charges one seat per player", () => {
  assertEquals(amountOwed({ guests: [] }, { pricePerPlayerFils: 3500 }), 3500);
});

Deno.test("amountOwed charges a guest the same as a player", () => {
  const game = { pricePerPlayerFils: 3500 };
  assertEquals(amountOwed({ guests: [g("a")] }, game), 7000);
  assertEquals(amountOwed({ guests: [g("a"), g("b")] }, game), 10500);
});

Deno.test("a bill that was already settled survives a price change", () => {
  // The organizer raised the price after this player was billed. What they
  // agreed to is what they owe.
  const signup = { guests: [], owedFils: 3000 };
  assertEquals(amountOwed(signup, { pricePerPlayerFils: 5000 }), 3000);
});

Deno.test("a settled bill of zero is kept, not treated as absent", () => {
  // A free game bills zero. Falling back to the price here would invent a
  // charge for someone who was told there was none.
  const signup = { guests: [g("a")], owedFils: 0 };
  assertEquals(amountOwed(signup, { pricePerPlayerFils: 5000 }), 0);
});

Deno.test("expectedTakeFils counts every seat that is billed", () => {
  assertEquals(
    expectedTakeFils({
      pricePerPlayerFils: 3000,
      confirmedCount: 6,
      guestCount: 2,
    }),
    24000,
  );
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

  // But an offer nobody accepted is not money owed.
  assertEquals(
    expectedTakeFils({ ...seats, pricePerPlayerFils: 3000 }),
    9000,
  );
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

function g(id: string) {
  return { id, name: `Guest ${id}` };
}
