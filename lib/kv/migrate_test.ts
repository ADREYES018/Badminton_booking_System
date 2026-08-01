import { assertEquals, assertThrows } from "@std/assert";
import { _internal, migrate } from "./migrate.ts";

/**
 * Migrations are exercised against a temporary entity so these tests keep
 * passing as real entities gain versions.
 */
function withFixture<T>(fn: () => T): T {
  const { CURRENT_VERSION, MIGRATIONS } = _internal;
  CURRENT_VERSION.widget = 3;
  MIGRATIONS.widget = {
    1: (r) => ({ ...r, v: 2, addedInV2: true }),
    2: (r) => ({ ...r, v: 3, addedInV3: "yes" }),
  };
  try {
    return fn();
  } finally {
    delete CURRENT_VERSION.widget;
    delete MIGRATIONS.widget;
  }
}

Deno.test("a v1 record is upgraded through every step", () => {
  withFixture(() => {
    const upgraded = migrate<Record<string, unknown>>(
      ["widget", "abc"],
      { v: 1, name: "old" },
    );
    assertEquals(upgraded.v, 3);
    assertEquals(upgraded.name, "old");
    assertEquals(upgraded.addedInV2, true);
    assertEquals(upgraded.addedInV3, "yes");
  });
});

Deno.test("a current-version record passes through untouched", () => {
  withFixture(() => {
    const record = { v: 3, name: "current" };
    assertEquals(migrate(["widget", "abc"], record), record);
  });
});

Deno.test("a record missing v is treated as v1", () => {
  withFixture(() => {
    const upgraded = migrate<Record<string, unknown>>(
      ["widget", "abc"],
      { name: "ancient" },
    );
    assertEquals(upgraded.v, 3);
    assertEquals(upgraded.addedInV2, true);
  });
});

Deno.test("a missing migration step fails loudly", () => {
  const { CURRENT_VERSION, MIGRATIONS } = _internal;
  CURRENT_VERSION.gap = 3;
  MIGRATIONS.gap = { 1: (r) => ({ ...r, v: 2 }) }; // no 2 -> 3 step
  try {
    assertThrows(
      () => migrate(["gap", "x"], { v: 1 }),
      Error,
      "Missing migration for gap v2 -> v3",
    );
  } finally {
    delete CURRENT_VERSION.gap;
    delete MIGRATIONS.gap;
  }
});

Deno.test("a step that fails to advance the version is rejected", () => {
  const { CURRENT_VERSION, MIGRATIONS } = _internal;
  CURRENT_VERSION.stuck = 2;
  MIGRATIONS.stuck = { 1: (r) => ({ ...r, v: 1 }) }; // forgot to bump
  try {
    assertThrows(
      () => migrate(["stuck", "x"], { v: 1 }),
      Error,
      "did not advance the version",
    );
  } finally {
    delete CURRENT_VERSION.stuck;
    delete MIGRATIONS.stuck;
  }
});

Deno.test("non-record values pass through untouched", () => {
  // Index pointers, counters and photo bytes are not versioned records.
  assertEquals(migrate(["user_by_email", "a@b.com"], "user-123"), "user-123");
  const bytes = new Uint8Array([1, 2, 3]);
  assertEquals(migrate(["photo", "user-1"], bytes), bytes);
  assertEquals(migrate(["waitlist_seq", "game-1"], 5), 5);
});

Deno.test("unknown entities are left alone", () => {
  const record = { v: 1, some: "thing" };
  assertEquals(migrate(["not_an_entity", "x"], record), record);
});
