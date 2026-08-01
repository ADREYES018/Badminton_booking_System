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

export type CourtMode = "fixed" | "flexible";
export type CourtStatus = "not_reserved" | "reserved" | "paid";
export type GameVisibility = "public" | "unlisted" | "password";
export type GameStatus =
  | "draft"
  | "open"
  | "full"
  | "cancelled"
  | "completed";

/**
 * How a guest (+1) is charged. Organizer picks this per game.
 *  - full_share: guest counts in the divisor, splits equally with members
 *  - flat_fee:   guest pays a fixed fee, deducted from the pot before split
 *  - free:       guest is excluded, members absorb the cost
 */
export type GuestPricingMode = "full_share" | "flat_fee" | "free";

export interface GuestPricing {
  mode: GuestPricingMode;
  /** Only meaningful when mode is "flat_fee". */
  feeFils: number;
}

export interface Venue {
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

export interface Game {
  v: 1;
  id: string;
  groupId: string;
  /** Unguessable for unlisted/password games; also used in URLs. */
  slug: string;
  title: string;
  venue: Venue;
  startUtc: string;
  endUtc: string;

  courts: number;
  courtMode: CourtMode;
  playersPerCourt: number;
  courtStatus: CourtStatus;

  totalCostFils: number;
  guestPricing: GuestPricing;
  /** Frozen at the cutoff; before then the UI shows a live estimate. */
  frozenPerHeadFils?: number;
  rosterFrozenAt?: string;

  skillMin?: Skill;
  skillMax?: Skill;

  visibility: GameVisibility;
  /** Only set when visibility is "password". */
  joinPasswordHash?: string;

  cutoffHours: number;
  status: GameStatus;

  /** Denormalized so a roster is never recomputed on page load. */
  confirmedCount: number;
  waitlistCount: number;
  guestCount: number;

  cancelledReason?: string;
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
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type MatchStatus = "pending" | "confirmed" | "rejected";

export interface Match {
  v: 1;
  id: string;
  gameId: string;
  groupId: string;
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
  ip?: string;
  createdAt: string;
  /** Where to send the user after a successful login. */
  redirectTo?: string;
}
