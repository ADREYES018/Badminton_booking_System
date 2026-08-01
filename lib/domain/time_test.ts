import { assertEquals } from "@std/assert";
import {
  canSelfCancel,
  cutoffAt,
  delayUntil,
  formatGameTime,
  isPastCutoff,
  promotionWindow,
} from "./time.ts";

const HOUR = 60 * 60 * 1000;
/** Saturday 9 Aug 2025, 19:00 Dubai == 15:00 UTC. */
const START = "2025-08-09T15:00:00.000Z";

function hoursBefore(n: number): Date {
  return new Date(new Date(START).getTime() - n * HOUR);
}

Deno.test("cutoffAt subtracts the configured hours from the start", () => {
  assertEquals(cutoffAt(START, 48).toISOString(), "2025-08-07T15:00:00.000Z");
  assertEquals(cutoffAt(START, 24).toISOString(), "2025-08-08T15:00:00.000Z");
});

Deno.test("isPastCutoff flips exactly at the boundary", () => {
  assertEquals(isPastCutoff(START, 48, hoursBefore(49)), false);
  // At the boundary the cutoff has been reached.
  assertEquals(isPastCutoff(START, 48, hoursBefore(48)), true);
  assertEquals(isPastCutoff(START, 48, hoursBefore(47)), true);
});

Deno.test("self-cancel is allowed only before the cutoff", () => {
  assertEquals(canSelfCancel(START, 48, hoursBefore(72)), true);
  assertEquals(canSelfCancel(START, 48, hoursBefore(48.5)), true);
  assertEquals(canSelfCancel(START, 48, hoursBefore(24)), false);
});

Deno.test("promotion gets the full 12h window when there is time", () => {
  const now = hoursBefore(96);
  const win = promotionWindow(START, 48, now);
  assertEquals(win.autoConfirm, false);
  assertEquals(
    win.confirmDeadline,
    new Date(now.getTime() + 12 * HOUR).toISOString(),
  );
});

Deno.test("promotion window is capped by the cutoff when that comes first", () => {
  // Six hours before the cutoff, so the window shortens from 12 to 6.
  const now = hoursBefore(54);
  const win = promotionWindow(START, 48, now);
  assertEquals(win.autoConfirm, false);
  assertEquals(win.confirmDeadline, cutoffAt(START, 48).toISOString());
});

Deno.test("promotion respects the one-hour floor past the cutoff", () => {
  // Already past the cutoff, but well before the game.
  const now = hoursBefore(12);
  const win = promotionWindow(START, 48, now);
  assertEquals(win.autoConfirm, false);
  // The cutoff is behind us, so the floor applies instead of a negative window.
  assertEquals(
    win.confirmDeadline,
    new Date(now.getTime() + HOUR).toISOString(),
  );
});

Deno.test("promotion auto-confirms inside the final hour", () => {
  const win = promotionWindow(START, 48, hoursBefore(0.5));
  assertEquals(win.autoConfirm, true);
  assertEquals(win.confirmDeadline, null);
});

Deno.test("promotion auto-confirms exactly at the one-hour mark", () => {
  const win = promotionWindow(START, 48, hoursBefore(1));
  assertEquals(win.autoConfirm, true);
});

Deno.test("promotion deadline never runs past the game start", () => {
  const now = hoursBefore(1.5);
  const win = promotionWindow(START, 48, now);
  assertEquals(win.autoConfirm, false);
  const deadline = new Date(win.confirmDeadline!).getTime();
  assertEquals(deadline <= new Date(START).getTime(), true);
});

Deno.test("delayUntil floors at zero for past deadlines", () => {
  const now = new Date(START);
  assertEquals(delayUntil(START, now), 0);
  assertEquals(delayUntil("2020-01-01T00:00:00.000Z", now), 0);
  assertEquals(
    delayUntil(new Date(now.getTime() + 3 * HOUR).toISOString(), now),
    3 * HOUR,
  );
});

Deno.test("game time renders in Dubai time in the house format", () => {
  // 15:00 UTC is 19:00 in Dubai.
  const formatted = formatGameTime(START, "2025-08-09T17:00:00.000Z");
  assertEquals(formatted, "Sat 9 Aug · 7:00–9:00 PM");
});

Deno.test("game time crossing midnight UTC stays on the Dubai day", () => {
  // 21:00 UTC on 9 Aug is 01:00 on 10 Aug in Dubai.
  const formatted = formatGameTime(
    "2025-08-09T21:00:00.000Z",
    "2025-08-09T22:00:00.000Z",
  );
  assertEquals(formatted.startsWith("Sun 10 Aug"), true);
});
