/**
 * Signups: joining, leaving, guests, the waitlist, and the cutoff freeze.
 *
 * This is the only module permitted to write a `signup` record or to change a
 * game's seat counters. That restriction is the design: capacity is decided in
 * exactly one place, so there is exactly one place to get it right.
 *
 * ## The oversell race
 *
 * Two players tap "join" on the last seat at the same instant. Both read the
 * game, both see one seat free, both decide "confirmed". Without a guard, both
 * commit and the court is oversold.
 *
 * Every seat-affecting function here follows the same shape:
 *
 *   withRetry(kv, async (kv) => {
 *     const gameEntry = await getRecord(kv, keys.game(id));   // fresh read
 *     ... decide, using this read ...
 *     return { op: kv.atomic()
 *       .check(gameEntry)          // <- nothing else moved the game
 *       .check(signupEntry)        // <- nothing else moved this signup
 *       .set(...), result };
 *   });
 *
 * `.check(gameEntry)` is the load-bearing line. The game record carries the
 * seat counters, so making the commit conditional on its versionstamp means
 * the loser of any race fails to commit, re-reads inside the retry, and makes
 * its decision again against the state the winner just wrote — landing on the
 * waitlist instead of a seat. The signup check is separate and guards a
 * different thing: the same user double-submitting.
 *
 * Reads must happen *inside* the callback. A read hoisted outside would hand
 * every retry the same stale versionstamp and spin until it threw.
 *
 * ## Two counters
 *
 * `confirmedCount` is seats held by players who are actually in. `pendingCount`
 * is seats held by promoted players who have not accepted yet. Capacity checks
 * use both; the cost split uses only the first. See the note on `Game` in
 * `types.ts` for why they must not be merged.
 */

import { keys, seqKey, type SignupStatus } from "../kv/keys.ts";
import {
  ConflictError,
  getRecord,
  listRecords,
  mutateRecord,
  nextSequence,
  withRetry,
} from "../kv/kv.ts";
import type { Game, Guest, Signup, User } from "../types.ts";
import { seatsRemaining } from "../domain/money.ts";
import {
  canSelfCancel,
  isPastCutoff,
  nowIso,
  promotionWindow,
} from "../domain/time.ts";
import { amountOwed } from "../domain/money.ts";
import {
  guestsAllowed,
  JOIN_BLOCK_MESSAGES,
  joinBlock,
} from "../domain/join_rules.ts";
import {
  enqueueCutoffFreeze,
  enqueuePromotion,
  enqueuePromotionExpiry,
  enqueueReminders,
} from "../queue/messages.ts";
import { cutoffAt } from "../domain/time.ts";

/** A refusal the player can act on, as opposed to a bug. */
export class SignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignupError";
  }
}

export type JoinOutcome = "confirmed" | "waitlisted";

export interface JoinResult {
  outcome: JoinOutcome;
  signup: Signup;
  /** Queue side effects the caller must flush; see `flush`. */
  effects: Effect[];
}

/**
 * Work that must happen *after* a commit succeeds, never inside the retry
 * callback.
 *
 * `withRetry` may run its callback several times. Enqueuing from inside would
 * post a message per attempt, including attempts that never committed. So
 * side effects are collected as data, returned, and flushed once.
 */
export type Effect =
  | { kind: "promote"; gameId: string }
  | {
    kind: "promotion_expiry";
    gameId: string;
    userId: string;
    confirmDeadline: string;
  };

export async function flush(kv: Deno.Kv, effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === "promote") {
      await enqueuePromotion(kv, effect.gameId);
    } else {
      await enqueuePromotionExpiry(
        kv,
        effect.gameId,
        effect.userId,
        effect.confirmDeadline,
      );
    }
  }
}

/**
 * Index key for a signup at a given status.
 *
 * Confirmed and pending entries are keyed by user id — order carries no
 * meaning, only membership does. Waitlisted entries are keyed by an allocated
 * sequence, because the queue's order *is* the rule being enforced.
 */
function indexKey(signup: Signup): Deno.KvKey {
  const seq = signup.status === "waitlisted"
    ? seqKey(signup.waitlistSeq ?? 0)
    : signup.userId;
  return keys.signupsByGame(signup.gameId, signup.status, seq);
}

/** Statuses that hold a seat and therefore appear in a roster listing. */
const ACTIVE: readonly SignupStatus[] = [
  "confirmed",
  "pending_confirm",
  "waitlisted",
];

export async function getSignup(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<Signup | null> {
  const entry = await getRecord<Signup>(kv, keys.signup(gameId, userId));
  return entry.value;
}

function newSignup(
  gameId: string,
  userId: string,
  status: SignupStatus,
  extras: Partial<Signup> = {},
): Signup {
  const now = nowIso();
  return {
    v: 1,
    gameId,
    userId,
    status,
    payment: "unpaid",
    guests: [],
    remindersSent: [],
    createdAt: now,
    updatedAt: now,
    ...extras,
  };
}

/**
 * Joins a game, landing on the roster or the waitlist depending on the seats
 * available at the moment the commit lands.
 *
 * `guests` are added in the same commit as the player's own seat, so a party
 * of three either gets three seats or none — a partial admission would leave
 * someone's guest stranded.
 */
export async function joinGame(
  kv: Deno.Kv,
  gameId: string,
  user: Pick<User, "id">,
  options: { guests?: Guest[] } = {},
): Promise<JoinResult> {
  const guests = options.guests ?? [];

  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) throw new SignupError("That game no longer exists.");

    const block = joinBlock(game);
    if (block) throw new SignupError(JOIN_BLOCK_MESSAGES[block]);

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, user.id),
    );
    const existing = signupEntry.value;
    if (existing && ACTIVE.includes(existing.status)) {
      throw new SignupError("You are already signed up for this game.");
    }

    if (guests.length > 0) {
      if (game.maxGuestsPerPlayer === 0) {
        throw new SignupError("This game does not allow guests.");
      }
      if (guests.length > game.maxGuestsPerPlayer) {
        throw new SignupError(
          `You can bring at most ${game.maxGuestsPerPlayer} guest${
            game.maxGuestsPerPlayer === 1 ? "" : "s"
          }.`,
        );
      }
      if (isPastCutoff(game.startUtc, game.cutoffHours)) {
        throw new SignupError("Guests can only be added before the cutoff.");
      }
    }

    const seatsWanted = 1 + guests.length;
    const roomFor = seatsRemaining(game);

    // A party only takes seats if the whole party fits. One seat left and a
    // player bringing a guest goes to the waitlist rather than splitting up.
    const confirmed = roomFor >= seatsWanted;

    let signup: Signup;
    let next: Game;

    if (confirmed) {
      signup = newSignup(gameId, user.id, "confirmed", { guests });
      next = {
        ...game,
        confirmedCount: game.confirmedCount + 1,
        guestCount: game.guestCount + guests.length,
        updatedAt: nowIso(),
      };
    } else {
      // Allocated outside the atomic op — a wasted sequence number on a failed
      // attempt costs nothing, since only relative order matters.
      const seq = await nextSequence(kv, keys.waitlistSeq(gameId));
      signup = newSignup(gameId, user.id, "waitlisted", {
        waitlistSeq: seq,
        // A waitlisted player holds no seats, so their guests are recorded as
        // an intention and only take seats if they are promoted.
        guests,
      });
      next = {
        ...game,
        waitlistCount: game.waitlistCount + 1,
        updatedAt: nowIso(),
      };
    }

    next.status = seatsRemaining(next) === 0 && next.status === "open"
      ? "full"
      : next.status;

    let op = kv.atomic()
      .check(gameEntry)
      .check(signupEntry)
      .set(keys.game(gameId), next)
      .set(keys.signup(gameId, user.id), signup)
      .set(indexKey(signup), user.id)
      .set(keys.signupsByUser(user.id, game.startUtc), gameId);

    // A previous cancellation leaves an index entry behind; clear it so the
    // player does not appear twice in a roster listing.
    if (existing) op = op.delete(indexKey(existing));

    return {
      op,
      result: {
        outcome: (confirmed ? "confirmed" : "waitlisted") as JoinOutcome,
        signup,
        effects: [] as Effect[],
      },
    };
  });

  if (!result) throw new ConflictError("Your sign-up did not go through.");
  return result;
}

export interface LeaveResult {
  signup: Signup;
  /** True when a confirmed seat was released and the waitlist should move. */
  seatFreed: boolean;
  effects: Effect[];
}

/**
 * Leaves a game.
 *
 * Before the cutoff this is a free cancellation. After it, the player forfeits
 * — they still come off the roster, but `payment` records that they owe the
 * organizer, since the court was booked on their behalf.
 */
export async function leaveGame(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  options: { byOrganizer?: boolean } = {},
): Promise<LeaveResult> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) throw new SignupError("That game no longer exists.");

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, userId),
    );
    const signup = signupEntry.value;
    if (!signup || !ACTIVE.includes(signup.status)) {
      throw new SignupError("You are not signed up for this game.");
    }

    const heldSeat = signup.status === "confirmed" ||
      signup.status === "pending_confirm";
    const forfeits = heldSeat && !options.byOrganizer &&
      !canSelfCancel(game.startUtc, game.cutoffHours);

    const next: Game = { ...game, updatedAt: nowIso() };

    if (signup.status === "confirmed") {
      next.confirmedCount = Math.max(0, game.confirmedCount - 1);
      next.guestCount = Math.max(0, game.guestCount - signup.guests.length);
    } else if (signup.status === "pending_confirm") {
      next.pendingCount = Math.max(0, game.pendingCount - 1);
      next.guestCount = Math.max(0, game.guestCount - signup.guests.length);
    } else {
      next.waitlistCount = Math.max(0, game.waitlistCount - 1);
    }

    // A game that was full has room again.
    if (next.status === "full" && seatsRemaining(next) > 0) {
      next.status = "open";
    }

    const cancelled: Signup = {
      ...signup,
      status: "cancelled",
      payment: forfeits ? "forfeited" : signup.payment,
      waitlistSeq: undefined,
      promotedAt: undefined,
      confirmDeadline: undefined,
      cancelledAt: nowIso(),
      updatedAt: nowIso(),
    };

    const op = kv.atomic()
      .check(gameEntry)
      .check(signupEntry)
      .set(keys.game(gameId), next)
      .set(keys.signup(gameId, userId), cancelled)
      .delete(indexKey(signup))
      .delete(keys.signupsByUser(userId, game.startUtc));

    return {
      op,
      result: {
        signup: cancelled,
        seatFreed: heldSeat,
        // Someone on the waitlist may now fit. Enqueued after the commit.
        effects: heldSeat
          ? [{ kind: "promote", gameId } as Effect]
          : [] as Effect[],
      },
    };
  });

  if (!result) throw new ConflictError("Your cancellation did not go through.");
  return result;
}

/**
 * Adds a guest to an already-confirmed signup.
 *
 * The seat check happens against a fresh read inside the commit, so a guest
 * cannot slip into a game that filled up while the form was on screen.
 */
export async function addGuest(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  guest: Omit<Guest, "id">,
): Promise<Signup> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) throw new SignupError("That game no longer exists.");

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, userId),
    );
    const signup = signupEntry.value;
    if (!signup || signup.status !== "confirmed") {
      throw new SignupError("Only confirmed players can bring a guest.");
    }
    if (isPastCutoff(game.startUtc, game.cutoffHours)) {
      throw new SignupError("Guests can only be added before the cutoff.");
    }
    if (game.maxGuestsPerPlayer === 0) {
      throw new SignupError("This game does not allow guests.");
    }
    if (signup.guests.length >= game.maxGuestsPerPlayer) {
      throw new SignupError(
        `You have already added your ${game.maxGuestsPerPlayer} guest${
          game.maxGuestsPerPlayer === 1 ? "" : "s"
        }.`,
      );
    }
    if (guestsAllowed(game, signup.guests.length) < 1) {
      throw new SignupError("There is no seat left for a guest.");
    }

    const next: Signup = {
      ...signup,
      guests: [...signup.guests, { ...guest, id: crypto.randomUUID() }],
      updatedAt: nowIso(),
    };

    const nextGame: Game = {
      ...game,
      guestCount: game.guestCount + 1,
      updatedAt: nowIso(),
    };
    if (seatsRemaining(nextGame) === 0 && nextGame.status === "open") {
      nextGame.status = "full";
    }

    return {
      op: kv.atomic()
        .check(gameEntry)
        .check(signupEntry)
        .set(keys.game(gameId), nextGame)
        .set(keys.signup(gameId, userId), next),
      result: next,
    };
  });

  if (!result) throw new ConflictError("Adding that guest did not go through.");
  return result;
}

export async function removeGuest(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  guestId: string,
): Promise<{ signup: Signup; effects: Effect[] }> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) throw new SignupError("That game no longer exists.");

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, userId),
    );
    const signup = signupEntry.value;
    if (!signup) throw new SignupError("You are not signed up for this game.");

    const guests = signup.guests.filter((g) => g.id !== guestId);
    if (guests.length === signup.guests.length) {
      throw new SignupError("That guest is not on your booking.");
    }

    const next: Signup = { ...signup, guests, updatedAt: nowIso() };
    const holdsSeats = signup.status === "confirmed" ||
      signup.status === "pending_confirm";

    const nextGame: Game = {
      ...game,
      guestCount: holdsSeats
        ? Math.max(0, game.guestCount - 1)
        : game.guestCount,
      updatedAt: nowIso(),
    };
    if (nextGame.status === "full" && seatsRemaining(nextGame) > 0) {
      nextGame.status = "open";
    }

    return {
      op: kv.atomic()
        .check(gameEntry)
        .check(signupEntry)
        .set(keys.game(gameId), nextGame)
        .set(keys.signup(gameId, userId), next),
      result: {
        signup: next,
        effects: holdsSeats
          ? [{ kind: "promote", gameId } as Effect]
          : [] as Effect[],
      },
    };
  });

  if (!result) throw new ConflictError("Removing that guest did not apply.");
  return result;
}

/** The next waitlisted signup in queue order, or null when the queue is empty. */
async function headOfWaitlist(
  kv: Deno.Kv,
  gameId: string,
): Promise<string | null> {
  const rows = await listRecords<string>(
    kv,
    { prefix: keys.signupsByGamePrefix(gameId, "waitlisted") },
    { limit: 1 },
  );
  return rows.at(0)?.value ?? null;
}

export interface PromotionResult {
  promoted: boolean;
  userId?: string;
  autoConfirmed?: boolean;
  effects: Effect[];
}

/**
 * Offers a freed seat to the head of the waitlist.
 *
 * Idempotent and safe to run concurrently with itself: if the seat has already
 * gone, the fresh read inside the retry sees no room and the call is a no-op.
 * That is the expected outcome when a duplicate queue delivery arrives, not an
 * error.
 *
 * Inside the final hour before a game there is no point asking — the seat is
 * granted outright. Otherwise the player holds it under `pending_confirm`
 * until their deadline, at which point `expirePromotion` releases it and
 * passes the offer along.
 */
export async function promoteNext(
  kv: Deno.Kv,
  gameId: string,
): Promise<PromotionResult> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) return null;
    if (game.status === "cancelled") return null;

    // Nothing to hand out.
    if (seatsRemaining(game) < 1) return null;

    const candidateId = await headOfWaitlist(kv, gameId);
    if (!candidateId) return null;

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, candidateId),
    );
    const signup = signupEntry.value;
    // The index pointed at someone who has since left; drop the stale pointer.
    if (!signup || signup.status !== "waitlisted") return null;

    // A waitlisted player's guests only take seats if the whole party fits.
    const seatsWanted = 1 + signup.guests.length;
    const guests = seatsRemaining(game) >= seatsWanted ? signup.guests : [];

    const window = promotionWindow(game.startUtc, game.cutoffHours);
    const now = nowIso();

    const next: Game = {
      ...game,
      waitlistCount: Math.max(0, game.waitlistCount - 1),
      guestCount: game.guestCount + guests.length,
      updatedAt: now,
    };

    let promotedSignup: Signup;

    if (window.autoConfirm) {
      next.confirmedCount = game.confirmedCount + 1;
      promotedSignup = {
        ...signup,
        status: "confirmed",
        guests,
        waitlistSeq: undefined,
        promotedAt: now,
        confirmDeadline: undefined,
        updatedAt: now,
      };
    } else {
      // Held, not confirmed: blocks the seat, stays out of the cost split.
      next.pendingCount = game.pendingCount + 1;
      promotedSignup = {
        ...signup,
        status: "pending_confirm",
        guests,
        waitlistSeq: undefined,
        promotedAt: now,
        confirmDeadline: window.confirmDeadline ?? undefined,
        updatedAt: now,
      };
    }

    if (seatsRemaining(next) === 0 && next.status === "open") {
      next.status = "full";
    }

    const effects: Effect[] = [];
    if (!window.autoConfirm && window.confirmDeadline) {
      effects.push({
        kind: "promotion_expiry",
        gameId,
        userId: candidateId,
        confirmDeadline: window.confirmDeadline,
      });
    }

    return {
      op: kv.atomic()
        .check(gameEntry)
        .check(signupEntry)
        .set(keys.game(gameId), next)
        .set(keys.signup(gameId, candidateId), promotedSignup)
        .delete(indexKey(signup))
        .set(indexKey(promotedSignup), candidateId),
      result: {
        promoted: true,
        userId: candidateId,
        autoConfirmed: window.autoConfirm,
        effects,
      },
    };
  });

  return result ?? { promoted: false, effects: [] };
}

/**
 * The organizer seating a named waitlisted player, whether or not there is
 * room.
 *
 * Distinct from `promoteNext` on three points, each deliberate:
 *
 * Capacity is not checked. An organizer who adds a court, or who knows the
 * roster better than the number does, is the authority on how many can play —
 * the seat count is their estimate, not a rule the app enforces against them.
 * The roster is allowed to exceed `maxPlayers` as a result, and `seatsRemaining`
 * already floors at zero, so an over-full game reads as full everywhere rather
 * than reporting negative seats.
 *
 * A specific player is named rather than the head of the queue, because the
 * point is overriding the order — waiting for the queue is what `promoteNext`
 * already does.
 *
 * The seat is granted outright rather than offered. A player being asked to
 * confirm within a deadline is the mechanism for a seat that freed up on its
 * own; here the organizer has decided, and making them wait on an acceptance
 * they did not ask for would strand the decision.
 *
 * Guests come along. They were recorded as an intention at join time and the
 * whole party is what the organizer is seating.
 */
export async function promotePlayer(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<Signup> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) throw new SignupError("That game no longer exists.");
    if (game.status === "cancelled") {
      throw new SignupError("That game has been cancelled.");
    }

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, userId),
    );
    const signup = signupEntry.value;
    if (!signup || signup.status !== "waitlisted") {
      throw new SignupError("That player is not on the waitlist.");
    }

    const now = nowIso();
    const promoted: Signup = {
      ...signup,
      status: "confirmed",
      waitlistSeq: undefined,
      promotedAt: now,
      confirmDeadline: undefined,
      updatedAt: now,
    };

    const next: Game = {
      ...game,
      waitlistCount: Math.max(0, game.waitlistCount - 1),
      confirmedCount: game.confirmedCount + 1,
      guestCount: game.guestCount + signup.guests.length,
      updatedAt: now,
    };

    if (seatsRemaining(next) === 0 && next.status === "open") {
      next.status = "full";
    }

    return {
      op: kv.atomic()
        .check(gameEntry)
        .check(signupEntry)
        .set(keys.game(gameId), next)
        .set(keys.signup(gameId, userId), promoted)
        .delete(indexKey(signup))
        .set(indexKey(promoted), userId),
      result: promoted,
    };
  });

  if (!result) throw new SignupError("That player could not be seated.");
  return result;
}

/**
 * A promoted player accepts their seat.
 *
 * The seat was already held at promotion time, so this moves it from pending
 * to confirmed — the capacity total does not change, but the cost divisor
 * does, which is the whole point of tracking them separately.
 */
export async function confirmPromotion(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<Signup> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) throw new SignupError("That game no longer exists.");

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, userId),
    );
    const signup = signupEntry.value;
    if (!signup || signup.status !== "pending_confirm") {
      throw new SignupError("You have no seat waiting to be confirmed.");
    }
    if (
      signup.confirmDeadline && new Date() > new Date(signup.confirmDeadline)
    ) {
      throw new SignupError("That offer has expired.");
    }

    const next: Signup = {
      ...signup,
      status: "confirmed",
      confirmDeadline: undefined,
      updatedAt: nowIso(),
    };

    const nextGame: Game = {
      ...game,
      pendingCount: Math.max(0, game.pendingCount - 1),
      confirmedCount: game.confirmedCount + 1,
      updatedAt: nowIso(),
    };

    return {
      op: kv.atomic()
        .check(gameEntry)
        .check(signupEntry)
        .set(keys.game(gameId), nextGame)
        .set(keys.signup(gameId, userId), next)
        .delete(indexKey(signup))
        .set(indexKey(next), userId),
      result: next,
    };
  });

  if (!result) throw new ConflictError("Confirming your seat did not apply.");
  return result;
}

export interface ExpiryResult {
  expired: boolean;
  effects: Effect[];
}

/**
 * Releases a seat whose confirm window ran out, and passes the offer on.
 *
 * Idempotent: a player who already accepted is no longer `pending_confirm`, so
 * a duplicate or late message finds nothing to do. The cascade to the next
 * person in line goes through the queue rather than a recursive call, so one
 * expiry cannot walk the whole waitlist inside a single handler.
 */
export async function expirePromotion(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  expectedDeadline?: string,
): Promise<ExpiryResult> {
  const result = await withRetry(kv, async (kv) => {
    const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
    const game = gameEntry.value;
    if (!game) return null;

    const signupEntry = await getRecord<Signup>(
      kv,
      keys.signup(gameId, userId),
    );
    const signup = signupEntry.value;
    if (!signup || signup.status !== "pending_confirm") return null;

    // A message left over from an earlier promotion of the same player.
    if (expectedDeadline && signup.confirmDeadline !== expectedDeadline) {
      return null;
    }
    // Fired early — the deadline has not actually arrived.
    if (
      signup.confirmDeadline && new Date() < new Date(signup.confirmDeadline)
    ) {
      return null;
    }

    const now = nowIso();
    const lapsed: Signup = {
      ...signup,
      status: "cancelled",
      waitlistSeq: undefined,
      confirmDeadline: undefined,
      cancelledAt: now,
      updatedAt: now,
    };

    const next: Game = {
      ...game,
      pendingCount: Math.max(0, game.pendingCount - 1),
      guestCount: Math.max(0, game.guestCount - signup.guests.length),
      updatedAt: now,
    };
    if (next.status === "full" && seatsRemaining(next) > 0) {
      next.status = "open";
    }

    return {
      op: kv.atomic()
        .check(gameEntry)
        .check(signupEntry)
        .set(keys.game(gameId), next)
        .set(keys.signup(gameId, userId), lapsed)
        .delete(indexKey(signup))
        .delete(keys.signupsByUser(userId, game.startUtc)),
      result: {
        expired: true,
        effects: [{ kind: "promote", gameId } as Effect],
      },
    };
  });

  return result ?? { expired: false, effects: [] };
}

/**
 * Freezes the roster at the cutoff, locks the per-head cost, and writes what
 * each confirmed player owes.
 *
 * Runs from the queue, and again lazily on read as a safety net. Idempotent by
 * checking `rosterFrozenAt`, and self-correcting: if the organizer pushed the
 * start time back after the freeze was scheduled, the cutoff has not actually
 * arrived, so this reschedules itself instead of freezing early. Deno KV
 * cannot cancel an enqueued message, which is why the handler has to be the
 * one to notice.
 *
 * ## Why `owedFils` is written here and never recalculated
 *
 * The per-head figure alone does not say what one player owes — someone who
 * brought a guest owes their own share plus the guest's, and under `flat_fee`
 * or `free` pricing that is not a multiple of anything. So each signup gets
 * its own total, computed once against the frozen split.
 *
 * Once written it never moves. A player who joins after the cutoff pays the
 * frozen rate and reduces nobody's bill; the organizer absorbs the difference.
 * The alternative — recomputing as the roster churns — means a player who has
 * already transferred money can silently become owed a refund, and there is no
 * good moment to tell them. "The cutoff decides what you owe" is a rule a
 * player can act on.
 *
 * The roster is written in the same atomic operation as the game, so a freeze
 * either locks everything or nothing. A partial freeze would leave some
 * players owing a figure derived from a split that no longer exists.
 */
export async function freezeRoster(
  kv: Deno.Kv,
  gameId: string,
): Promise<{ frozen: boolean; rescheduled: boolean }> {
  const game = await getRecord<Game>(kv, keys.game(gameId));
  if (!game.value) return { frozen: false, rescheduled: false };
  if (game.value.status === "cancelled") {
    return { frozen: false, rescheduled: false };
  }
  if (game.value.rosterFrozenAt) return { frozen: false, rescheduled: false };

  if (!isPastCutoff(game.value.startUtc, game.value.cutoffHours)) {
    const cutoff = cutoffAt(game.value.startUtc, game.value.cutoffHours);
    await enqueueCutoffFreeze(kv, gameId, cutoff.toISOString());
    return { frozen: false, rescheduled: true };
  }

  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<Game>(kv, keys.game(gameId));
    const current = entry.value;
    if (!current || current.rosterFrozenAt) return null;

    const now = nowIso();
    const next: Game = {
      ...current,
      rosterFrozenAt: now,
      updatedAt: now,
    };

    let op = kv.atomic().check(entry).set(keys.game(gameId), next);

    // Only confirmed players owe anything. A held seat is not a bill: the
    // player never accepted it, and an offer that lapses must not leave a
    // charge behind.
    //
    // Stamping `owedFils` here is what makes a later price change safe. The
    // price no longer moves with the roster, but an organizer can still edit
    // it, and everyone who joined under the old figure keeps it.
    const confirmed = await listRoster(kv, gameId, "confirmed");
    for (const signup of confirmed) {
      const entryForSignup = await getRecord<Signup>(
        kv,
        keys.signup(gameId, signup.userId),
      );
      // Someone left between the listing and here; the retry will re-read.
      if (!entryForSignup.value) continue;

      op = op
        .check(entryForSignup)
        .set(
          keys.signup(gameId, signup.userId),
          {
            ...entryForSignup.value,
            owedFils: amountOwed(entryForSignup.value, current),
            updatedAt: now,
          } satisfies Signup,
        );
    }

    return { op, result: true };
  });

  // Scheduled only on the commit that actually froze, and only after it — a
  // retry that lost its race must not leave a set of reminders behind.
  if (result === true) {
    const frozen = await getRecord<Game>(kv, keys.game(gameId));
    if (frozen.value) {
      await enqueueReminders(kv, gameId, frozen.value.startUtc);
    }
  }

  return { frozen: result === true, rescheduled: false };
}

export interface PaymentResult {
  signup: Signup;
}

/**
 * A player states they have transferred their share.
 *
 * This is a claim, not a confirmation — the money moves by bank transfer
 * outside the app, so nothing here can verify it arrived. The organizer
 * confirms separately. Keeping the two apart means a player has a record of
 * having paid even before the organizer gets to their bank statement, and a
 * disagreement is visible as `marked_paid` rather than hidden.
 */
export async function markPaid(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<Signup> {
  return await mutateRecord<Signup>(
    kv,
    keys.signup(gameId, userId),
    async (kv) => {
      const entry = await getRecord<Signup>(kv, keys.signup(gameId, userId));
      const signup = entry.value;
      if (!signup) {
        throw new SignupError(
          "You are not signed up for this game.",
        );
      }
      if (signup.status !== "confirmed") {
        throw new SignupError("Only confirmed players have a share to pay.");
      }
      // Already confirmed by the organizer: a later claim must not undo that.
      if (signup.payment === "paid" || signup.payment === "refunded") {
        return null;
      }

      // Players pay before the cutoff, so the bill is settled here rather than
      // waiting for the freeze to stamp it. Recording the figure at the moment
      // of the claim is what ties the payment to a specific amount: a later
      // price change, or a guest added afterwards, cannot retroactively make
      // what they sent the wrong number.
      const game = await getRecord<Game>(kv, keys.game(gameId));
      if (!game.value) throw new SignupError("That game no longer exists.");

      return {
        op: kv.atomic().check(entry).set(
          keys.signup(gameId, userId),
          {
            ...signup,
            payment: "marked_paid",
            owedFils: amountOwed(signup, game.value),
            paidMarkedAt: nowIso(),
            updatedAt: nowIso(),
          } satisfies Signup,
        ),
        result: true,
      };
    },
  );
}

/**
 * The organizer confirms money actually arrived.
 *
 * This is the authoritative state — `marked_paid` is the player's word,
 * `paid` is the organizer's. The organizer may confirm a payment the player
 * never marked, since plenty of people transfer without touching the app.
 */
export async function confirmPaid(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
  confirmedBy: string,
): Promise<Signup> {
  return await mutateRecord<Signup>(
    kv,
    keys.signup(gameId, userId),
    async (kv) => {
      const entry = await getRecord<Signup>(kv, keys.signup(gameId, userId));
      const signup = entry.value;
      if (!signup) throw new SignupError("That player is not on this roster.");
      if (signup.payment === "paid") return null;

      // An organizer can confirm money that arrived before the player said
      // anything, so the bill may not have been recorded yet. Settling it here
      // as well means the confirmed figure is the one that was owed when the
      // organizer saw the transfer.
      const game = await getRecord<Game>(kv, keys.game(gameId));
      if (!game.value) throw new SignupError("That game no longer exists.");

      const now = nowIso();
      return {
        op: kv.atomic().check(entry).set(
          keys.signup(gameId, userId),
          {
            ...signup,
            payment: "paid",
            owedFils: amountOwed(signup, game.value),
            paidConfirmedAt: now,
            paidConfirmedBy: confirmedBy,
            updatedAt: now,
          } satisfies Signup,
        ),
        result: true,
      };
    },
  );
}

/**
 * Records that money went back to a player.
 *
 * Like `confirmPaid`, this records a transfer that happened in a bank rather
 * than performing one — the app never moves money. Only a payment that was
 * actually confirmed can be refunded; refunding an unpaid signup would assert
 * the organizer sent back money they never received.
 *
 * The player's own refund IBAN is the account this pays to, which is why that
 * one is encrypted while the group's receiving IBAN is not.
 */
export async function refundPayment(
  kv: Deno.Kv,
  gameId: string,
  userId: string,
): Promise<Signup> {
  return await mutateRecord<Signup>(
    kv,
    keys.signup(gameId, userId),
    async (kv) => {
      const entry = await getRecord<Signup>(kv, keys.signup(gameId, userId));
      const signup = entry.value;
      if (!signup) throw new SignupError("That player is not on this roster.");
      if (signup.payment === "refunded") return null;
      if (signup.payment !== "paid") {
        throw new SignupError(
          "Only a confirmed payment can be refunded.",
        );
      }

      return {
        op: kv.atomic().check(entry).set(
          keys.signup(gameId, userId),
          {
            ...signup,
            payment: "refunded",
            updatedAt: nowIso(),
          } satisfies Signup,
        ),
        result: true,
      };
    },
    "That refund did not go through.",
  );
}

/**
 * Cancels a game and marks every confirmed payment for refund.
 *
 * A cancelled game owes everyone their money back, so this is the one place
 * a bulk refund makes sense. Players who never paid are left alone rather
 * than marked refunded — there is nothing to send them.
 *
 * Returns the players whose payments need returning, so the organizer has a
 * list to work from at their bank.
 */
export async function refundAllForGame(
  kv: Deno.Kv,
  gameId: string,
): Promise<{ refunded: string[]; totalFils: number }> {
  const confirmed = await listRoster(kv, gameId, "confirmed");
  const refunded: string[] = [];
  let totalFils = 0;

  for (const signup of confirmed) {
    if (signup.payment !== "paid") continue;
    await refundPayment(kv, gameId, signup.userId);
    refunded.push(signup.userId);
    totalFils += signup.owedFils ?? 0;
  }

  return { refunded, totalFils };
}

export interface Settlement {
  owedFils: number;
  collectedFils: number;
  outstandingFils: number;
  refundedFils: number;
  paidCount: number;
  markedCount: number;
  unpaidCount: number;
  refundedCount: number;
}

/**
 * What the organizer is owed for a game and how much has come in.
 *
 * `marked_paid` counts as outstanding, not collected — until the organizer
 * confirms it, the money is only claimed. Reporting it as collected would
 * make the figure that matters most, "how much am I still out of pocket",
 * the one most likely to be wrong.
 *
 * This is meaningful from the moment the first player joins rather than only
 * after the cutoff: players pay up front, so an organizer needs to see who has
 * settled while there is still time to chase the rest.
 */
export async function settlementFor(
  kv: Deno.Kv,
  gameId: string,
): Promise<Settlement> {
  const gameEntry = await getRecord<Game>(kv, keys.game(gameId));
  const game = gameEntry.value;
  if (!game) throw new SignupError("That game no longer exists.");

  const confirmed = await listRoster(kv, gameId, "confirmed");

  let owedFils = 0;
  let collectedFils = 0;
  let refundedFils = 0;
  let paidCount = 0;
  let markedCount = 0;
  let unpaidCount = 0;
  let refundedCount = 0;

  for (const signup of confirmed) {
    // A player who has neither paid nor been through the freeze carries no
    // recorded bill yet, but they hold a seat and the price is known — so what
    // they owe is the price, not nothing. Counting them as zero would tell an
    // organizer they were square when half the roster had not paid.
    const owed = amountOwed(signup, game);

    if (signup.payment === "refunded") {
      // Money that came in and went back out again. It is neither owed nor
      // held, so it stays out of both the bill and the collected figure.
      refundedFils += owed;
      refundedCount++;
      continue;
    }

    owedFils += owed;

    if (signup.payment === "paid") {
      collectedFils += owed;
      paidCount++;
    } else if (signup.payment === "marked_paid") {
      markedCount++;
    } else {
      unpaidCount++;
    }
  }

  return {
    owedFils,
    collectedFils,
    outstandingFils: owedFils - collectedFils,
    refundedFils,
    paidCount,
    markedCount,
    unpaidCount,
    refundedCount,
  };
}

export interface RosterEntry {
  signup: Signup;
  userId: string;
}

/** Signups at one status, in index order. */
export async function listRoster(
  kv: Deno.Kv,
  gameId: string,
  status: SignupStatus,
  limit = 200,
): Promise<Signup[]> {
  const pointers = await listRecords<string>(
    kv,
    { prefix: keys.signupsByGamePrefix(gameId, status) },
    { limit },
  );

  const signups = await Promise.all(
    pointers.map((p) => getSignup(kv, gameId, p.value)),
  );
  return signups.filter((s): s is Signup => s !== null);
}

/** Everyone holding or waiting on a seat, grouped by status. */
export async function loadRoster(kv: Deno.Kv, gameId: string): Promise<{
  confirmed: Signup[];
  pending: Signup[];
  waitlisted: Signup[];
}> {
  const [confirmed, pending, waitlisted] = await Promise.all([
    listRoster(kv, gameId, "confirmed"),
    listRoster(kv, gameId, "pending_confirm"),
    listRoster(kv, gameId, "waitlisted"),
  ]);

  // The waitlist index is keyed by sequence, so it arrives in order already;
  // sorting again costs nothing and survives a future key change.
  waitlisted.sort((a, b) => (a.waitlistSeq ?? 0) - (b.waitlistSeq ?? 0));

  return { confirmed, pending, waitlisted };
}

/** Upcoming games a player is signed up for, soonest first. */
export async function listUserSignups(
  kv: Deno.Kv,
  userId: string,
  options: { from?: Date; limit?: number } = {},
): Promise<string[]> {
  const from = (options.from ?? new Date()).toISOString();
  const rows = await listRecords<string>(kv, {
    start: keys.signupsByUser(userId, from),
    end: keys.signupsByUser(userId, "9999"),
  }, { limit: options.limit ?? 50 });
  return rows.map((r) => r.value);
}
