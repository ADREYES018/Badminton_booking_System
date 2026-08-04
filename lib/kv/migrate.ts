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
  game: 2,
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
 */
const MIGRATIONS: Record<Entity, Record<number, MigrationStep>> = {
  game: {
    /**
     * v2 replaces a court total that the roster divided with a price the
     * organizer sets per seat.
     *
     * The old figure has to be converted, and the only honest conversion is
     * whatever the game was actually charging. A frozen game already has that
     * number recorded, so it is used as-is and nobody's bill moves. An open
     * game has no settled figure — its per-head estimate changed with every
     * join — so the total is divided by the roster as it stands, which is what
     * the page was quoting the moment before the upgrade.
     *
     * An empty roster divides by one: the whole cost is what the first player
     * would have owed, and quoting zero would advertise a paid game as free.
     */
    1: (record) => {
      const total = typeof record.totalCostFils === "number"
        ? record.totalCostFils
        : 0;
      const frozen = typeof record.frozenPerHeadFils === "number"
        ? record.frozenPerHeadFils
        : undefined;
      const confirmed = typeof record.confirmedCount === "number"
        ? record.confirmedCount
        : 0;

      const {
        totalCostFils: _totalCostFils,
        guestPricing: _guestPricing,
        frozenPerHeadFils: _frozenPerHeadFils,
        ...rest
      } = record;

      return {
        ...rest,
        v: 2,
        pricePerPlayerFils: frozen ?? Math.ceil(total / Math.max(confirmed, 1)),
      };
    },
  },
};

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
