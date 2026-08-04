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
 * Two clubs, because every screen is now scoped to one and a single club
 * cannot show that it is.
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
const {
  createGroupForOwner,
  DEFAULT_GROUP_SLUG,
  ensureMembership,
  requestToJoin,
  updatePayout,
} = await import("../lib/data/groups.ts");
const { createSession, sessionCookie } = await import("../lib/auth/session.ts");
const { mintCheckinToken } = await import("../lib/domain/checkin.ts");
const { updateUser } = await import("../lib/data/users.ts");

const HOUR_MS = 60 * 60 * 1000;
const kv = await getKv();

/**
 * Gives a seeded account a phone number.
 *
 * The games list sends anyone without one to `/profile/setup` before it
 * renders, since a player with no phone cannot be put on a roster. That is
 * right in the app and useless in a demo, where the first screen anyone opens
 * would be a redirect.
 */
let phoneSeq = 0;
async function reachable<T extends { id: string }>(user: T): Promise<T> {
  await updateUser(kv, user.id, {
    phone: `+97150${String(1_000_000 + phoneSeq++).padStart(7, "0")}`,
  });
  return user;
}

async function seedReachablePlayers(count: number) {
  const players = await seedPlayers(kv, count);
  for (const player of players) await reachable(player);
  return players;
}

// An open game: the cutoff is days away, so joining and leaving both work.
const open = await seedGame(kv, {
  courts: 2,
  maxPlayers: 8,
  pricePerPlayerFils: 3000,
  cutoffHours: 48,
  startUtc: new Date(Date.now() + 96 * HOUR_MS).toISOString(),
});

await updatePayout(kv, open.groupId, {
  bank: "Emirates NBD",
  accountName: "Smash Club",
  iban: "AE070331234567890123456",
});

// Two players already in, so the roster is not empty and a third can still
// join from the browser. Nothing joins a club on its own any more, so every
// player is seated in it explicitly — the same act an invite performs.
const joiners = await seedReachablePlayers(2);
for (const player of joiners) {
  await ensureMembership(kv, open.groupId, player.id);
  await joinGame(kv, open.game.id, player);
}

// A frozen game: the cutoff has passed but the game has not started, which is
// the only window where players can have joined *and* shares exist.
const frozen = await seedGame(kv, {
  courts: 1,
  // Exactly the four players seeded onto it below, so the roster is full and
  // a fifth join exercises the waitlist.
  maxPlayers: 4,
  pricePerPlayerFils: 3000,
  cutoffHours: 2,
  startUtc: new Date(Date.now() + HOUR_MS).toISOString(),
});

// Both games land in the same club: `ensureDefaultGroup` is idempotent on the
// slug, so only the first organizer seeded owns it. Organizer rights are
// checked per club — a global `role: "organizer"` grants nothing — so the
// second one is seated as an organizer of it explicitly.
await ensureMembership(kv, frozen.groupId, frozen.organizer.id, "organizer");
await reachable(frozen.organizer);
await reachable(open.organizer);

const roster = await seedReachablePlayers(4);
for (const player of roster) {
  await ensureMembership(kv, frozen.groupId, player.id);
  await joinGame(kv, frozen.game.id, player);
}
await freezeRoster(kv, frozen.game.id);

const cookie = async (user: { id: string }) =>
  sessionCookie((await createSession(kv, user as never)).id, false).split(
    ";",
  )[0];

// In the club but on no roster: exercises the join button.
const visitor = (await seedReachablePlayers(1))[0]!;
await ensureMembership(kv, open.groupId, visitor.id);

// In no club at all: sees a club's public games with the way in offered, and
// is refused by every control that would seat them.
const outsider = (await seedReachablePlayers(1))[0]!;

// A second club, so the club picker and the per-club URLs have something to
// be about. Its owner administers it and nothing else.
const rivalOwner = (await seedReachablePlayers(1))[0]!;
const rival = await createGroupForOwner(kv, {
  name: "Marina Smashers",
  slug: "marina-smashers",
  ownerId: rivalOwner.id,
  description: "A second club, to prove the first one's screens are scoped.",
});

// Someone waiting on a decision, so the members page has a request to settle.
const applicant = (await seedReachablePlayers(1))[0]!;
await requestToJoin(kv, open.groupId, applicant.id, "Played with Sam before");

const club = `/g/${DEFAULT_GROUP_SLUG}`;

console.log(
  JSON.stringify(
    {
      url: `http://localhost:${PORT}`,
      clubs: {
        smashClub: `${club}/games`,
        marinaSmashers: `/g/${rival.slug}/games`,
        picker: "/groups",
      },
      openGame: `/games/${open.game.slug}`,
      frozenGame: `/games/${frozen.game.slug}`,
      organizerScreens: {
        members: `${club}/members`,
        settings: `${club}/settings`,
        settlement: `${club}/organizer/games/${frozen.game.slug}/settlement`,
        newGame: `${club}/organizer/games/new`,
      },
      cookies: {
        // In the club, on no roster: use this to exercise the join button.
        visitor: await cookie(visitor),
        // In no club: sees the games but is offered the way in instead of RSVP.
        outsider: await cookie(outsider),
        // Waiting on the organizer to approve their request.
        applicant: await cookie(applicant),
        // On the frozen roster: has a share to pay and a check-in code.
        player: await cookie(roster[0]!),
        // Runs the frozen game: sees the scanner and the settlement screen.
        organizer: await cookie(frozen.organizer),
        // Owns the other club, and administers nothing here.
        rivalOwner: await cookie(rivalOwner),
      },
      checkinToken: await mintCheckinToken(roster[0]!.id),
    },
    null,
    2,
  ),
);

kv.close();
