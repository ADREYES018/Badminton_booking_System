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
  /** Attempts before giving up. Contention here is short-lived. */
  attempts?: number;
  /** Base backoff in ms; grows with jitter to break up thundering herds. */
  baseDelayMs?: number;
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
  const attempts = options.attempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 5;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const planned = await fn(kv);
    if (planned === null) return null;

    const commit = await planned.op.commit();
    if (commit.ok) return planned.result;

    // Someone else committed first. Back off a little, then re-read and redo
    // the decision against the new state.
    const jitter = Math.random() * baseDelayMs;
    const delay = baseDelayMs * 2 ** attempt + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new ConflictError(
    `Failed to commit after ${attempts} attempts due to contention`,
  );
}

/**
 * Atomically increments a counter and returns the new value.
 * Used for waitlist positions, where a read-then-max+1 would hand two players
 * the same slot.
 */
export async function nextSequence(
  kv: Deno.Kv,
  key: Deno.KvKey,
): Promise<number> {
  const result = await kv.atomic().sum(key, 1n).commit();
  if (!result.ok) throw new ConflictError("Could not allocate sequence");
  const entry = await kv.get<Deno.KvU64>(key);
  return Number(entry.value?.value ?? 0n);
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
