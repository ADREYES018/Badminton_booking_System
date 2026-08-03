/**
 * Seeds a database with everything a manual or browser-driven walkthrough
 * needs, and prints the session cookies to reach it.
 *
 *   deno run -A --unstable-kv tools/seed_demo.ts
 *
 * Two games, because the interesting screens have opposite time requirements:
 * an open game to exercise joining, and a frozen one to exercise payment,
 * check-in codes and the scanner. One game cannot be both.
 *
 * Writes to `KV_PATH` (default `demo.kv`), never to the development database,
 * so running it twice is cheap and running it by accident costs nothing.
 */

import { encodeBase64 } from "@std/encoding/base64";

const KV_PATH = Deno.env.get("KV_PATH") ?? "demo.kv";
const PORT = Deno.env.get("PORT") ?? "8123";

// Fixed test secrets. These are for a throwaway local database and are not
// the secrets any real deployment uses.
Deno.env.set("KV_PATH", KV_PATH);
Deno.env.set("IBAN_ENC_KEY", encodeBase64(new Uint8Array(32).fill(7)));
Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));
Deno.env.set("APP_URL", `http://localhost:${PORT}`);

const { getKv } = await import("../lib/kv/kv.ts");
const { seedGame, seedPlayers } = await import("../lib/testing/fixtures.ts");
const { freezeRoster, joinGame } = await import("../lib/data/signups.ts");
const { updatePayout } = await import("../lib/data/groups.ts");
const { createSession, sessionCookie } = await import("../lib/auth/session.ts");
const { mintCheckinToken } = await import("../lib/domain/checkin.ts");

const HOUR_MS = 60 * 60 * 1000;
const kv = await getKv();

// An open game: the cutoff is days away, so joining and leaving both work.
const open = await seedGame(kv, {
  courts: 2,
  playersPerCourt: 4,
  totalCostFils: 24000,
  cutoffHours: 48,
  startUtc: new Date(Date.now() + 96 * HOUR_MS).toISOString(),
});

await updatePayout(kv, open.groupId, {
  bank: "Emirates NBD",
  accountName: "Smash Club",
  iban: "AE070331234567890123456",
});

// Two players already in, so the roster is not empty and a third can still
// join from the browser.
const joiners = await seedPlayers(kv, 2);
for (const player of joiners) await joinGame(kv, open.game.id, player);

// A frozen game: the cutoff has passed but the game has not started, which is
// the only window where players can have joined *and* shares exist.
const frozen = await seedGame(kv, {
  courts: 1,
  playersPerCourt: 4,
  totalCostFils: 12000,
  cutoffHours: 2,
  startUtc: new Date(Date.now() + HOUR_MS).toISOString(),
});

const roster = await seedPlayers(kv, 4);
for (const player of roster) await joinGame(kv, frozen.game.id, player);
await freezeRoster(kv, frozen.game.id);

const cookie = async (user: { id: string }) =>
  sessionCookie((await createSession(kv, user as never)).id, false).split(
    ";",
  )[0];

const visitor = (await seedPlayers(kv, 1))[0]!;

console.log(
  JSON.stringify(
    {
      url: `http://localhost:${PORT}`,
      openGame: `/games/${open.game.slug}`,
      frozenGame: `/games/${frozen.game.slug}`,
      cookies: {
        // Has joined nothing: use this to exercise the join button.
        visitor: await cookie(visitor),
        // On the frozen roster: has a share to pay and a check-in code.
        player: await cookie(roster[0]!),
        // Runs the frozen game: sees the scanner and the settlement screen.
        organizer: await cookie(frozen.organizer),
      },
      checkinToken: await mintCheckinToken(frozen.game.id, roster[0]!.id),
    },
    null,
    2,
  ),
);

kv.close();
