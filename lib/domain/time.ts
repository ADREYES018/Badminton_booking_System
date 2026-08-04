/**
 * Time and cutoff rules.
 *
 * Everything is stored UTC and displayed Asia/Dubai. Dubai is UTC+4 with no
 * daylight saving, but we still format through Intl rather than adding four
 * hours by hand, so the app stays correct if that ever changes.
 */

export const APP_TIMEZONE = "Asia/Dubai";

const HOUR_MS = 60 * 60 * 1000;

/** Waitlist confirm window, capped by the cutoff. */
export const WAITLIST_CONFIRM_WINDOW_HOURS = 12;
/**
 * Never give a promoted player less than this to respond. Inside this margin
 * we skip the confirm step entirely and promote straight to confirmed.
 */
export const WAITLIST_MIN_WINDOW_HOURS = 1;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Cutoff instant: `cutoffHours` before the game starts. */
export function cutoffAt(startUtc: string, cutoffHours: number): Date {
  return new Date(new Date(startUtc).getTime() - cutoffHours * HOUR_MS);
}

export function isPastCutoff(
  startUtc: string,
  cutoffHours: number,
  now: Date = new Date(),
): boolean {
  return now >= cutoffAt(startUtc, cutoffHours);
}

/**
 * Players may cancel freely only before the cutoff. After it, a cancellation
 * forfeits payment and needs the organizer.
 */
export function canSelfCancel(
  startUtc: string,
  cutoffHours: number,
  now: Date = new Date(),
): boolean {
  return !isPastCutoff(startUtc, cutoffHours, now);
}

export interface PromotionWindow {
  /** When the promoted player must confirm by; null means auto-confirmed. */
  confirmDeadline: string | null;
  /** True when too little time remains to bother asking. */
  autoConfirm: boolean;
}

/**
 * Works out how long a promoted player gets to accept.
 *
 * 12 hours by default, shortened to the cutoff if that comes first, but never
 * shorter than the one-hour floor. If under an hour remains before the game
 * starts, the seat is granted outright rather than left hanging.
 */
export function promotionWindow(
  startUtc: string,
  cutoffHours: number,
  now: Date = new Date(),
): PromotionWindow {
  const start = new Date(startUtc).getTime();
  const cutoff = cutoffAt(startUtc, cutoffHours).getTime();
  const current = now.getTime();

  const untilStart = start - current;
  if (untilStart <= WAITLIST_MIN_WINDOW_HOURS * HOUR_MS) {
    return { confirmDeadline: null, autoConfirm: true };
  }

  const standard = current + WAITLIST_CONFIRM_WINDOW_HOURS * HOUR_MS;
  // Prefer the cutoff when it lands sooner, but respect the one-hour floor.
  const bounded = Math.min(standard, Math.max(cutoff, current + HOUR_MS));
  // Never run past the game itself.
  const deadline = Math.min(bounded, start);

  return {
    confirmDeadline: new Date(deadline).toISOString(),
    autoConfirm: false,
  };
}

/**
 * The longest delay Deno KV will accept on an enqueued message.
 *
 * Anything beyond this is rejected outright, which took down posting a game
 * more than about a month out — the cutoff freeze was scheduled past the
 * limit and `kv.enqueue` threw before the redirect.
 */
export const MAX_QUEUE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Milliseconds until a deadline, for `kv.enqueue` delays.
 *
 * Floored at zero, because a deadline in the past means "now", and capped at
 * the queue's own limit, because a longer wait is not expressible.
 *
 * Capping is safe rather than lossy: every handler re-reads the live record
 * and reschedules itself when it fires early — the same mechanism that makes
 * an edited start time work, since queued messages cannot be cancelled. A
 * game booked a year out simply wakes up monthly until its cutoff is real.
 */
export function delayUntil(iso: string, now: Date = new Date()): number {
  const until = new Date(iso).getTime() - now.getTime();
  return Math.min(MAX_QUEUE_DELAY_MS, Math.max(0, until));
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Renders "Sat 9 Aug · 7:00–9:00 PM", the format the design system specifies. */
export function formatGameTime(startUtc: string, endUtc: string): string {
  const start = new Date(startUtc);
  const end = new Date(endUtc);
  const day = dateFmt.format(start);
  const from = timeFmt.format(start).replace(/\s?[ap]m$/i, "");
  const to = timeFmt.format(end).toUpperCase();
  return `${day} · ${from}–${to}`;
}

export function formatDubaiDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function formatDubaiTime(iso: string): string {
  return timeFmt.format(new Date(iso)).toUpperCase();
}

/** Relative phrasing for deadlines, e.g. "in 3h" or "in 2 days". */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 1) return `in ${Math.max(1, Math.floor(diff / 60000))} min`;
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
