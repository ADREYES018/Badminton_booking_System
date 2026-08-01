/**
 * KV connection and the atomic-retry primitive the whole app leans on.
 *
 * The single most important correctness problem in this app is the oversell
 * race: two players tapping "join" on the last seat must not both get in.
 * `withRetry` is the answer — read a record with its versionstamp, compute,
 * then commit conditionally. If another writer won, re-read and try again.
 */

import { migrate } from "./migrate.ts";

let kvInstance: Deno.Kv | null = null;

/**
 * Opens the shared KV handle. On Deno Deploy `KV_PATH` is unset and the
 * managed database is used; locally it points at a file.
 */
export async function getKv(): Promise<Deno.Kv> {
  if (kvInstance) return kvInstance;
  const path = Deno.env.get("KV_PATH");
  kvInstance = await Deno.openKv(path || undefined);
  return kvInstance;
}

/** Tests use a fresh in-memory database per case. */
export function setKv(kv: Deno.Kv | null): void {
  kvInstance = kv;
}

export function closeKv(): void {
  if (kvInstance) {
    kvInstance.close();
    kvInstance = null;
  }
}

/** Read one record, upgrading it to the current shape on the way out. */
export async function getRecord<T>(
  kv: Deno.Kv,
  key: Deno.KvKey,
): Promise<Deno.KvEntryMaybe<T>> {
  const entry = await kv.get<T>(key);
  if (entry.value === null) return entry;
  const migrated = migrate<T>(key, entry.value);
  return {
    key: entry.key,
    value: migrated,
    versionstamp: entry.versionstamp,
  } as Deno.KvEntryMaybe<T>;
}

export class ConflictError extends Error {
  constructor(message = "Conflicting concurrent update, please retry") {
    super(message);
    this.name = "ConflictError";
  }
}

export interface RetryOptions {
  /**
   * Attempts before giving up.
   *
   * The default is sized for the worst realistic case in this app: a whole
   * group tapping "join" on a newly posted game. Every one of those writers
   * contends on the same game record, so they serialize, and a writer near the
   * back of the queue legitimately loses many times before its turn. Measured
   * against 40 simultaneous joins, 8 attempts rejected roughly a quarter of
   * them; 24 clears that comfortably.
   */
  attempts?: number;
  /** Base backoff in ms; grows with jitter to break up thundering herds. */
  baseDelayMs?: number;
  /**
   * Ceiling on a single backoff wait.
   *
   * Uncapped exponential growth is the wrong shape for a queue that drains at
   * a steady rate: by the eighth attempt it is sleeping most of a second, so
   * the caller waits far longer than the work in front of it actually takes.
   * Capping keeps the tail responsive.
   */
  maxDelayMs?: number;
}

/**
 * Runs `fn` until its atomic commit succeeds.
 *
 * `fn` must do all of its reads *inside* the callback so each retry sees fresh
 * versionstamps, and must return the un-committed atomic operation. Returning
 * `null` means "nothing to do" and stops the loop.
 *
 * @example
 * await withRetry(kv, async (kv) => {
 *   const game = await getRecord<Game>(kv, keys.game(id));
 *   if (!game.value) return null;
 *   return {
 *     op: kv.atomic()
 *       .check(game)                                  // nobody else moved it
 *       .check({ key: signupKey, versionstamp: null }) // not already joined
 *       .set(keys.game(id), next)
 *       .set(signupKey, signup),
 *     result: signup,
 *   };
 * });
 */
export async function withRetry<T>(
  kv: Deno.Kv,
  fn: (kv: Deno.Kv) => Promise<
    { op: Deno.AtomicOperation; result: T } | null
  >,
  options: RetryOptions = {},
): Promise<T | null> {
  const attempts = options.attempts ?? 24;
  const baseDelayMs = options.baseDelayMs ?? 5;
  const maxDelayMs = options.maxDelayMs ?? 60;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const planned = await fn(kv);
    if (planned === null) return null;

    const commit = await planned.op.commit();
    if (commit.ok) return planned.result;

    // Someone else committed first. Back off a little, then re-read and redo
    // the decision against the new state. The wait grows exponentially to
    // break up a thundering herd, but is capped — see `maxDelayMs`.
    const jitter = Math.random() * baseDelayMs;
    const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs) + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new ConflictError(
    `Failed to commit after ${attempts} attempts due to contention`,
  );
}

/**
 * Claims the next number in a sequence and returns the value this caller got.
 *
 * Used for waitlist positions, where two players handed the same number would
 * collide on one index key and one of them would silently vanish from the
 * queue.
 *
 * The obvious implementation — `kv.atomic().sum(key, 1n)` followed by a plain
 * `kv.get` — increments safely but *reads* unsafely: between the sum and the
 * get, another caller may have incremented again, so both callers read the
 * same later value. The increment is atomic; the read-back is not. Instead the
 * counter is read and written under a versionstamp check, which makes the
 * returned number the one that this commit actually claimed.
 */
export async function nextSequence(
  kv: Deno.Kv,
  key: Deno.KvKey,
): Promise<number> {
  const claimed = await withRetry(kv, async (kv) => {
    const entry = await kv.get<number>(key);
    const next = (entry.value ?? 0) + 1;
    return {
      op: kv.atomic().check(entry).set(key, next),
      result: next,
    };
  });

  if (claimed === null) throw new ConflictError("Could not allocate sequence");
  return claimed;
}

/** Collects a list query into an array, migrating each record on read. */
export async function listRecords<T>(
  kv: Deno.Kv,
  selector: Deno.KvListSelector,
  options?: Deno.KvListOptions,
): Promise<Array<{ key: Deno.KvKey; value: T }>> {
  const out: Array<{ key: Deno.KvKey; value: T }> = [];
  for await (const entry of kv.list<T>(selector, options)) {
    out.push({ key: entry.key, value: migrate<T>(entry.key, entry.value) });
  }
  return out;
}
