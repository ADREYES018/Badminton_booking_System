/**
 * What a check-in token accepts and what it refuses.
 *
 * Each refusal gets its own case, because they fail for different reasons and
 * a single "invalid token" test would pass while three of the four checks
 * were missing.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));

const {
  CheckinError,
  checkinVersionOf,
  mintCheckinToken,
  verifyCheckinToken,
} = await import("./checkin.ts");

const USER = "user-xyz";

Deno.test("a minted token reads back as its own claim", async () => {
  const token = await mintCheckinToken(USER);
  assertEquals(await verifyCheckinToken(token), { userId: USER, version: 1 });
});

Deno.test("the same player mints the same code every time", async () => {
  // This is the whole point of the phase: one code a player can save to their
  // photo roll and use at every game, rather than one per game per ten minutes.
  assertEquals(await mintCheckinToken(USER), await mintCheckinToken(USER));
});

Deno.test("a tampered signature is refused", async () => {
  const token = await mintCheckinToken(USER);
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");

  await assertRejects(
    () => verifyCheckinToken(tampered),
    CheckinError,
    "could not be verified",
  );
});

Deno.test("a code minted for one player cannot be re-pointed at another", async () => {
  const token = await mintCheckinToken(USER);
  const swapped = token.replace(USER, "user-someone-else");

  await assertRejects(
    () => verifyCheckinToken(swapped),
    CheckinError,
    "could not be verified",
  );
});

Deno.test("bumping the version retires the old code", async () => {
  const leaked = await mintCheckinToken(USER, 1);
  const replacement = await mintCheckinToken(USER, 2);

  assertEquals((await verifyCheckinToken(replacement)).version, 2);
  // The old code still verifies as version 1. It is the caller comparing that
  // against the user's stored version that retires it — see the route test.
  assertEquals((await verifyCheckinToken(leaked)).version, 1);
});

Deno.test("a Phase 5 token is refused before any signature is computed", async () => {
  // Four parts, not three. Old codes cannot survive the format change.
  await assertRejects(
    () => verifyCheckinToken("game-abc.user-xyz.5901234.deadbeefdeadbeef"),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("a malformed token is refused", async () => {
  await assertRejects(
    () => verifyCheckinToken("nonsense"),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("a non-numeric version is refused", async () => {
  await assertRejects(
    () => verifyCheckinToken(`${USER}.two.deadbeefdeadbeef`),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("a user record without the field reads as version 1", () => {
  // Every user predating this phase is in exactly this state.
  assertEquals(checkinVersionOf({ id: USER } as never), 1);
  assertEquals(checkinVersionOf({ id: USER, checkinVersion: 4 } as never), 4);
});
