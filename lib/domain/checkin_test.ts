/**
 * What a check-in token accepts and what it refuses.
 *
 * Each refusal gets its own case, because they fail for different reasons and
 * a single "invalid token" test would pass while three of the four checks were
 * missing.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));

const {
  CHECKIN_WINDOW_SECONDS,
  CheckinError,
  mintCheckinToken,
  verifyCheckinToken,
  windowAt,
} = await import("./checkin.ts");

const GAME = "game-abc";
const USER = "user-xyz";
const WINDOW_MS = 300 * 1000;

Deno.test("a freshly minted token reads back as its own claim", async () => {
  const token = await mintCheckinToken(GAME, USER);
  assertEquals(await verifyCheckinToken(token, GAME), {
    gameId: GAME,
    userId: USER,
  });
});

Deno.test("a token minted for one game cannot be spent on another", async () => {
  const token = await mintCheckinToken(GAME, USER);

  await assertRejects(
    () => verifyCheckinToken(token, "game-different"),
    CheckinError,
    "different game",
  );
});

Deno.test("a token still works as the window rolls over", async () => {
  const now = new Date();
  const token = await mintCheckinToken(GAME, USER, now);

  // One bucket later: the code was minted in what is now the previous window,
  // which is exactly the walk-from-the-door case.
  const later = new Date(now.getTime() + WINDOW_MS);
  assertEquals((await verifyCheckinToken(token, GAME, later)).userId, USER);
});

Deno.test("a token two windows old is refused", async () => {
  const now = new Date();
  const token = await mintCheckinToken(GAME, USER, now);

  const muchLater = new Date(now.getTime() + 2 * WINDOW_MS);
  await assertRejects(
    () => verifyCheckinToken(token, GAME, muchLater),
    CheckinError,
    "expired",
  );
});

Deno.test("a token from a clock running ahead is refused", async () => {
  const now = new Date();
  const token = await mintCheckinToken(
    GAME,
    USER,
    new Date(now.getTime() + 2 * WINDOW_MS),
  );

  // Accepting a future bucket would extend the token's life rather than
  // preserve it.
  await assertRejects(
    () => verifyCheckinToken(token, GAME, now),
    CheckinError,
    "expired",
  );
});

Deno.test("a tampered signature is refused", async () => {
  const token = await mintCheckinToken(GAME, USER);
  const [gameId, userId, window, mac] = token.split(".");

  // Flip one hex character of the MAC and nothing else.
  const flipped = mac![0] === "0" ? `1${mac!.slice(1)}` : `0${mac!.slice(1)}`;

  await assertRejects(
    () => verifyCheckinToken(`${gameId}.${userId}.${window}.${flipped}`, GAME),
    CheckinError,
    "could not be verified",
  );
});

Deno.test("a token claiming another player is refused", async () => {
  const token = await mintCheckinToken(GAME, USER);
  const [gameId, , window, mac] = token.split(".");

  // The ids travel in the clear, so the MAC is the only thing binding them.
  await assertRejects(
    () => verifyCheckinToken(`${gameId}.someone-else.${window}.${mac}`, GAME),
    CheckinError,
    "could not be verified",
  );
});

Deno.test("a malformed string is refused rather than parsed loosely", async () => {
  for (const bad of ["", "nonsense", "a.b.c", "a.b.c.d.e"]) {
    await assertRejects(
      () => verifyCheckinToken(bad, GAME),
      CheckinError,
    );
  }
});

Deno.test("a non-numeric window is refused", async () => {
  await assertRejects(
    () =>
      verifyCheckinToken(`${GAME}.${USER}.notanumber.abcdef0123456789`, GAME),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("the window advances once per period", () => {
  const now = new Date();
  assertEquals(
    windowAt(new Date(now.getTime() + CHECKIN_WINDOW_SECONDS * 1000)),
    windowAt(now) + 1,
  );
});
