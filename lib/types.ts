/**
 * Domain records. Every stored record carries `v` so `lib/kv/migrate.ts` can
 * upgrade it on read — KV is schemaless, and retrofitting versioning later is
 * painful.
 *
 * Money is always integer fils (1 AED = 100 fils). No floats go near money.
 * Timestamps are UTC ISO strings; every user-facing date renders Asia/Dubai.
 */

export type PlatformRole = "super_admin" | "organizer" | "player";
export type GroupRole = "organizer" | "player";
export type Skill = "beginner" | "intermediate" | "advanced" | "competitive";

export const SKILL_ORDER: readonly Skill[] = [
  "beginner",
  "intermediate",
  "advanced",
  "competitive",
];

/** AES-256-GCM ciphertext. Never logged, never returned from a list endpoint. */
export interface EncryptedField {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

export interface StoredIban {
  encrypted: EncryptedField;
  /** Account holder name is stored in clear; only the IBAN itself is secret. */
  holder: string;
  /** Last 4 digits, so the UI can show "•••• 1234" without decrypting. */
  last4: string;
  consentAt: string;
}

export interface User {
  v: 1;
  id: string;
  email: string;
  emailLower: string;
  name: string;
  /** E.164, UAE default +971. */
  phone?: string;
  skill: Skill;
  gender?: "m" | "f" | "other";
  /** Present when a photo exists at keys.photo(id). */
  hasPhoto: boolean;
  role: PlatformRole;
  /**
   * Bumped to retire a leaked check-in code. Absent means 1, so no existing
   * record needs migrating.
   */
  checkinVersion?: number;
  /** Player's own refund account. Distinct from a group's payout account. */
  iban?: StoredIban;
  emailOptIn: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A group's public receiving account, shown to players with a copy button. */
export interface PayoutDetails {
  bank: string;
  accountName: string;
  iban: string;
}

export interface Group {
  v: 1;
  id: string;
  slug: string;
  name: string;
  description?: string;
  ownerId: string;
  payout?: PayoutDetails;
  /** Default applied to new games; overridable per game. */
  defaultCutoffHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  v: 1;
  groupId: string;
  userId: string;
  role: GroupRole;
  blocked: boolean;
  blockReason?: string;
  blockedAt?: string;
  blockedBy?: string;
  joinedAt: string;
}

/**
 * A single-use link that admits one player to a group.
 *
 * Stored under a hash of the token, never the token itself, so a database dump
 * yields no working invite — the same rule magic-link tokens follow.
 */
export interface GroupInvite {
  v: 1;
  groupId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Set once redeemed. The record outlives its use so a second tap on the
   * link can say "already used" rather than "no such invite". */
  redeemedAt?: string;
  redeemedBy?: string;
}

export type JoinRequestStatus = "pending" | "approved" | "rejected";

/**
 * A player asking an organizer to let them into a group.
 *
 * The record survives its decision so a rejected applicant is not silently
 * re-queued by tapping the button again, and so an organizer can see who they
 * have already turned away.
 */
export interface JoinRequest {
  v: 1;
  groupId: string;
  userId: string;
  status: JoinRequestStatus;
  message?: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

/**
 * The racquet sport a game is played in.
 *
 * Stored on the game rather than the club: one club runs badminton on Sunday
 * and padel on Wednesday, and a player filtering the list cares which of those
 * tonight's game is, not who organizes it.
 */
export type Sport =
  | "badminton"
  | "pickleball"
  | "table_tennis"
  | "squash"
  | "padel";

export const SPORTS: readonly Sport[] = [
  "badminton",
  "pickleball",
  "table_tennis",
  "squash",
  "padel",
];

/**
 * What each sport is called on screen.
 *
 * Kept beside the type so a new sport cannot be added without naming it, which
 * is what would otherwise reach the UI as a raw `table_tennis`.
 */
export const SPORT_LABELS: Record<Sport, string> = {
  badminton: "Badminton",
  pickleball: "Pickleball",
  table_tennis: "Table tennis",
  squash: "Squash",
  padel: "Padel",
};

/**
 * The sport a game is assumed to be when nothing says otherwise.
 *
 * Every game predating the sport field is badminton — that is what the app was
 * built for and the only thing anyone has posted, so the migration can assign
 * it without guessing.
 */
export const DEFAULT_SPORT: Sport = "badminton";

export function isSport(value: string): value is Sport {
  return (SPORTS as readonly string[]).includes(value);
}

export type CourtMode = "fixed" | "flexible";
export type CourtStatus = "not_reserved" | "reserved" | "paid";
export type GameVisibility = "public" | "unlisted" | "password";
export type GameStatus =
  | "draft"
  | "open"
  | "full"
  | "cancelled"
  | "completed";

/** Guests allowed per player when the organizer has not chosen otherwise. */
export const DEFAULT_MAX_GUESTS_PER_PLAYER = 1;

export interface Venue {
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

export interface Game {
  v: 3;
  id: string;
  /**
   * The club running this game, or `null` for one that belongs to nobody.
   *
   * A clubless game is posted by a player who organizes nothing: they picked a
   * venue, named a price and want people to turn up. It behaves like any other
   * game except that the club-scoped features have nothing to hang off —
   * settlement, payout details and per-club stats all require a club, and are
   * simply absent rather than faked with a placeholder one.
   *
   * Its creator holds the organizer rights instead, which is why every guard
   * checks `createdBy` before it reaches for a membership.
   */
  groupId: string | null;
  /** Unguessable for unlisted/password games; also used in URLs. */
  slug: string;
  title: string;
  /** Which racquet sport. Drives the list's icon and its filter. */
  sport: Sport;
  venue: Venue;
  startUtc: string;
  endUtc: string;

  /** How many courts are booked. Shown to players; does not set capacity. */
  courts: number;
  courtMode: CourtMode;
  /**
   * Total seats on the game.
   *
   * Organizers were previously asked for players *per court* and the capacity
   * was multiplied out, which forced an even split across courts and could not
   * express "three courts, ten players" — the ordinary case where someone
   * books a spare court so nobody sits out the whole session. The organizer
   * now states the roster size they want and books whatever courts suit it, so
   * the two numbers are independent.
   *
   * Named for what it is rather than `playersPerCourt`, which is what it used
   * to mean; `lib/kv/migrate.ts` converts the old field at v3.
   */
  maxPlayers: number;
  courtStatus: CourtStatus;

  /**
   * What one seat costs. The organizer sets it outright rather than posting a
   * court total for the roster to divide, so the figure a player is quoted
   * when they join is the figure they are billed — it cannot move because
   * somebody else dropped out.
   *
   * A guest seat costs the same as a player's, so a signup with one guest owes
   * twice this.
   */
  pricePerPlayerFils: number;
  /** 0 disables guests entirely. */
  maxGuestsPerPlayer: number;
  rosterFrozenAt?: string;

  skillMin?: Skill;
  skillMax?: Skill;

  visibility: GameVisibility;
  /**
   * The six digits that unlock a password game, stored in clear.
   *
   * Unlike a sign-in code this is not a credential and is not secret from the
   * organizer — its whole purpose is to be read off the screen and passed on,
   * so it has to survive being read back. It gates who may see a roster and
   * take a seat, nothing else, and it is never shown to anyone who has not
   * already cleared it.
   *
   * Only set when visibility is "password".
   */
  joinCode?: string;

  cutoffHours: number;
  status: GameStatus;

  /**
   * Denormalized so a roster is never recomputed on page load.
   *
   * `confirmedCount` and `pendingCount` deliberately stay separate rather than
   * being summed into one "taken" figure, because they answer two different
   * questions:
   *
   *   capacity = confirmedCount + pendingCount + guestCount
   *   who owes = confirmedCount
   *
   * A promoted player holds a seat for up to 12 hours before accepting. That
   * seat must block other joins, but it is not a bill — the player never took
   * it, and charging for an offer that lapsed would be wrong.
   */
  confirmedCount: number;
  /** Seats held by promoted players who have not yet accepted. */
  pendingCount: number;
  waitlistCount: number;
  guestCount: number;

  cancelledReason?: string;
  /**
   * Set when the game is deleted. The record and its roster survive.
   *
   * A deleted game is gone from every listing and from its organizer's view,
   * but the signups, payments and audit entries behind it are untouched — a
   * game somebody paid into must not be able to erase the fact that they did.
   * Nothing reads a deleted game except the audit trail, so this is a hide
   * rather than a status: `status` describes a game that exists, and a deleted
   * one has no state left to be in.
   */
  deletedAt?: string;
  deletedBy?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Guest {
  id: string;
  name: string;
  phone?: string;
}

export type PaymentStatus =
  | "unpaid"
  | "marked_paid"
  | "paid"
  | "refunded"
  | "forfeited";

export type ReminderTag = "pay" | "t36" | "t24" | "t3";

export interface Signup {
  v: 1;
  gameId: string;
  userId: string;
  status: import("./kv/keys.ts").SignupStatus;
  payment: PaymentStatus;

  /** Position in the waitlist queue; absent once confirmed. */
  waitlistSeq?: number;
  promotedAt?: string;
  /** Deadline to accept a promotion. Absent when auto-confirmed. */
  confirmDeadline?: string;

  /** Each guest occupies a seat and is charged per the game's guest pricing. */
  guests: Guest[];

  /** Frozen at cutoff: this player's share plus their guests'. */
  owedFils?: number;
  paidMarkedAt?: string;
  paidConfirmedAt?: string;
  paidConfirmedBy?: string;

  remindersSent: ReminderTag[];
  attendedAt?: string;
  /**
   * Set when the organizer marks a player absent.
   *
   * `attendedAt` alone cannot express this: its absence means "not marked
   * yet", which is not the same as "marked as a no-show" and must not count
   * against anyone. The two fields are mutually exclusive.
   */
  markedAbsentAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type MatchStatus = "pending" | "confirmed" | "rejected";

export interface Match {
  v: 1;
  id: string;
  gameId: string;
  /**
   * The club whose leaderboard this match counts toward, or `null` when the
   * game belongs to no club.
   *
   * Results on a clubless game are still recorded and still confirmed by the
   * losing side — what they cannot do is move a ranking, because there is no
   * club whose ranking it would be. See `recordMatchStats`.
   */
  groupId: string | null;
  /** Doubles: two players per side, drawn from the attended roster. */
  sideA: [string, string];
  sideB: [string, string];
  scoreA: number;
  scoreB: number;
  status: MatchStatus;
  reportedBy: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface PlayerStats {
  v: 1;
  groupId: string;
  userId: string;
  attended: number;
  noShow: number;
  /** Confirmed matches only; pending and rejected never count. */
  wins: number;
  losses: number;
  gamesPlayed: number;
  updatedAt: string;
}

export interface AuditEntry {
  v: 1;
  actorId: string;
  targetId?: string;
  groupId?: string;
  action: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  ts: string;
}

export interface Session {
  v: 1;
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  ip?: string;
  userAgent?: string;
}

export interface MagicToken {
  v: 1;
  email: string;
  emailLower: string;
  /** SHA-256 of the six digits. The code itself is never stored. */
  codeHash: string;
  ip?: string;
  createdAt: string;
  /** Where to send the user after a successful login. */
  redirectTo?: string;
  /**
   * Wrong guesses so far. A code is six digits, so it is guessable in a way a
   * 32-byte token never was; the record is destroyed once this runs out.
   */
  attempts: number;
}
