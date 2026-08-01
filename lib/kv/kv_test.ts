/**
 * The atomic-retry primitive.
 *
 * The contention case here is not hypothetical: every player joining a game
 * writes the same game record, so a busy sign-up serializes dozens of writers
 * through one key. An earlier 8-attempt budget rejected roughly a quarter of
 * 40 simultaneous joins with a ConflictError — safe, in that nothing was
 * oversold, but the players saw a failure where they should have seen a seat
 * or a waitlist place.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { withTestKv } from "../testing/kv_test_helper.ts";
import { ConflictError, getRecord, nextSequence, withRetry } from "./kv.ts";

const COUNTER_KEY = ["test_counter"];

/** Increments a single record — the shape every seat mutation shares. */
function bumpCounter(kv: Deno.Kv) {
  return withRetry(kv, async (kv) => {
    const entry = await getRecord<{ n: number }>(kv, COUNTER_KEY);
    const n = (entry.value?.n ?? 0) + 1;
    return {
      op: kv.atomic().check(entry).set(COUNTER_KEY, { n }),
      result: n,
    };
  });
}

Deno.test("withRetry commits a straightforward update", async () => {
  await withTestKv(async (kv) => {
    assertEquals(await bumpCounter(kv), 1);
    assertEquals(await bumpCounter(kv), 2);
  });
});

Deno.test("returning null from the callback means nothing to do", async () => {
  await withTestKv(async (kv) => {
    const result = await withRetry(kv, () => Promise.resolve(null));
    assertEquals(result, null);
  });
});

Deno.test("fifty writers contending on one key all succeed", async () => {
  await withTestKv(async (kv) => {
    const writers = 50;
    const results = await Promise.allSettled(
      Array.from({ length: writers }, () => bumpCounter(kv)),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    assertEquals(
      rejected.length,
      0,
      "contention on a hot key must not surface as a user-visible error",
    );

    // Every writer saw a distinct value, and none was lost.
    const entry = await getRecord<{ n: number }>(kv, COUNTER_KEY);
    assertEquals(entry.value?.n, writers);
  });
});

Deno.test("withRetry gives up rather than spinning forever", async () => {
  await withTestKv(async (kv) => {
    await assertRejects(
      () =>
        withRetry(kv, async (kv) => {
          const entry = await getRecord<{ n: number }>(kv, COUNTER_KEY);
          // Write behind the callback's back, so the check can never hold.
          await kv.set(COUNTER_KEY, { n: Math.random() });
          return {
            op: kv.atomic().check(entry).set(COUNTER_KEY, { n: 1 }),
            result: 1,
          };
        }, { attempts: 3, baseDelayMs: 1 }),
      ConflictError,
    );
  });
});

Deno.test("backoff is capped so a long queue stays responsive", async () => {
  await withTestKv(async (kv) => {
    const started = Date.now();
    await assertRejects(
      () =>
        withRetry(kv, async (kv) => {
          const entry = await getRecord<{ n: number }>(kv, COUNTER_KEY);
          await kv.set(COUNTER_KEY, { n: Math.random() });
          return {
            op: kv.atomic().check(entry).set(COUNTER_KEY, { n: 1 }),
            result: 1,
          };
        }, { attempts: 12, baseDelayMs: 5, maxDelayMs: 20 }),
      ConflictError,
    );

    // Uncapped, twelve exponential waits from a 5ms base would exceed 20
    // seconds. Capped at 20ms they cannot.
    const elapsed = Date.now() - started;
    assert(elapsed < 2000, `backoff ran long: ${elapsed}ms`);
  });
});

Deno.test("nextSequence hands out distinct numbers under contention", async () => {
  await withTestKv(async (kv) => {
    const key = ["test_seq"];
    const allocated = await Promise.all(
      Array.from({ length: 30 }, () => nextSequence(kv, key)),
    );

    // The counter is atomic, so no two callers may receive the same position —
    // this is what keeps two waitlisted players off the same slot.
    assertEquals(new Set(allocated).size, allocated.length);
    assertEquals(Math.max(...allocated), 30);
  });
});
