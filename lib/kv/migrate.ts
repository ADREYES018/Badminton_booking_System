/**
 * Migrate-on-read.
 *
 * KV is schemaless, so old records keep their old shape until something writes
 * them again. Every record carries `v`; this module upgrades a record to the
 * current version as it is read, so the rest of the app only ever sees the
 * latest shape.
 *
 * Adding a migration:
 *   1. bump CURRENT_VERSION for that entity
 *   2. add a step keyed by the version it upgrades *from*
 *   3. bump the `v` literal on the interface in lib/types.ts
 *
 * Steps run in sequence, so a v1 record passes through every step to reach the
 * newest version. This is exercised by lib/kv/migrate_test.ts.
 */

/** Entity name, taken from the first element of the key. */
type Entity = string;

/** Upgrades a record one version forward. */
type MigrationStep = (
  record: Record<string, unknown>,
) => Record<string, unknown>;

/** Current version per entity. Absent means "no migrations yet, v1". */
const CURRENT_VERSION: Record<Entity, number> = {
  user: 1,
  group: 1,
  member: 1,
  game: 1,
  signup: 1,
  match: 1,
  stats: 1,
  session: 1,
  magic_token: 1,
  audit: 1,
};

/**
 * Migration steps, keyed by entity then by source version.
 * `MIGRATIONS.game[1]` upgrades a v1 game to v2.
 *
 * Example, for when a future version adds a field:
 *   game: {
 *     1: (r) => ({ ...r, v: 2, guestPricing: { mode: "full_share", feeFils: 0 } }),
 *   },
 */
const MIGRATIONS: Record<Entity, Record<number, MigrationStep>> = {};

function isVersionedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Uint8Array);
}

/**
 * Upgrades a value read from KV to the current shape for its entity.
 * Values that are not versioned records (index pointers, counters, photo
 * bytes) pass through untouched.
 */
export function migrate<T>(key: Deno.KvKey, value: T): T {
  const entity = typeof key[0] === "string" ? key[0] : null;
  if (entity === null) return value;

  const target = CURRENT_VERSION[entity];
  if (target === undefined) return value;
  if (!isVersionedRecord(value)) return value;

  const steps = MIGRATIONS[entity];
  if (steps === undefined) return value;

  let record: Record<string, unknown> = value;
  let version = typeof record.v === "number" ? record.v : 1;

  while (version < target) {
    const step = steps[version];
    if (step === undefined) {
      throw new Error(
        `Missing migration for ${entity} v${version} -> v${version + 1}`,
      );
    }
    record = step(record);
    const next = typeof record.v === "number" ? record.v : version + 1;
    if (next <= version) {
      throw new Error(
        `Migration for ${entity} v${version} did not advance the version`,
      );
    }
    version = next;
  }

  return record as T;
}

/** Exposed for tests and for a future offline backfill tool. */
export const _internal = { CURRENT_VERSION, MIGRATIONS };
