import { assertEquals, assertNotEquals } from "@std/assert";
import {
  consumeMagicToken,
  createSession,
  destroyAllSessions,
  destroySession,
  getSession,
  issueMagicToken,
  rateLimit,
  readSessionCookie,
  sessionCookie,
} from "./session.ts";
import { createUser, findOrCreateUser, getUserByEmail } from "../data/users.ts";
import { setTestEnv, withTestKv } from "../testing/kv_test_helper.ts";
import { keys } from "../kv/keys.ts";
import { sha256Hex } from "../crypto.ts";

setTestEnv();

Deno.test("magic token is stored hashed, never in clear", async () => {
  await withTestKv(async (kv) => {
    const { token } = await issueMagicToken(kv, "player@example.com");

    // The raw token must not be a key in the database.
    const rawLookup = await kv.get(keys.magicToken(token));
    assertEquals(rawLookup.value, null);

    // Only its hash is.
    const hashed = await kv.get(keys.magicToken(await sha256Hex(token)));
    assertNotEquals(hashed.value, null);
  });
});

Deno.test("magic token can only be redeemed once", async () => {
  await withTestKv(async (kv) => {
    const { token } = await issueMagicToken(kv, "player@example.com");

    const first = await consumeMagicToken(kv, token);
    assertEquals(first?.emailLower, "player@example.com");

    // A second click on the same link must fail.
    const second = await consumeMagicToken(kv, token);
    assertEquals(second, null);
  });
});

Deno.test("two concurrent redemptions of one token yield exactly one login", async () => {
  await withTestKv(async (kv) => {
    const { token } = await issueMagicToken(kv, "player@example.com");

    const results = await Promise.all([
      consumeMagicToken(kv, token),
      consumeMagicToken(kv, token),
      consumeMagicToken(kv, token),
    ]);

    const successes = results.filter((r) => r !== null);
    assertEquals(successes.length, 1);
  });
});

Deno.test("unknown magic token is rejected", async () => {
  await withTestKv(async (kv) => {
    assertEquals(await consumeMagicToken(kv, "not-a-real-token"), null);
  });
});

Deno.test("session round-trips and can be destroyed", async () => {
  await withTestKv(async (kv) => {
    const user = await createUser(kv, {
      email: "player@example.com",
      name: "Player One",
    });
    const session = await createSession(kv, user, { ip: "10.0.0.1" });

    const loaded = await getSession(kv, session.id);
    assertEquals(loaded?.userId, user.id);

    await destroySession(kv, session);
    assertEquals(await getSession(kv, session.id), null);
  });
});

Deno.test("destroyAllSessions signs out every device", async () => {
  await withTestKv(async (kv) => {
    const user = await createUser(kv, {
      email: "player@example.com",
      name: "Player One",
    });
    const phone = await createSession(kv, user);
    const laptop = await createSession(kv, user);

    await destroyAllSessions(kv, user.id);

    assertEquals(await getSession(kv, phone.id), null);
    assertEquals(await getSession(kv, laptop.id), null);
  });
});

Deno.test("session cookie is HttpOnly, SameSite=Lax, Secure in production", () => {
  const secure = sessionCookie("abc123", true);
  assertEquals(secure.includes("HttpOnly"), true);
  assertEquals(secure.includes("SameSite=Lax"), true);
  assertEquals(secure.includes("Secure"), true);

  // Secure would break plain-HTTP local development.
  const local = sessionCookie("abc123", false);
  assertEquals(local.includes("Secure"), false);
});

Deno.test("session cookie is parsed out of a crowded cookie header", () => {
  const req = new Request("http://localhost", {
    headers: { cookie: "theme=dark; sc_session=xyz789; other=1" },
  });
  assertEquals(readSessionCookie(req), "xyz789");

  const none = new Request("http://localhost", {
    headers: { cookie: "theme=dark" },
  });
  assertEquals(readSessionCookie(none), null);
});

Deno.test("rate limit allows up to the limit then blocks", async () => {
  await withTestKv(async (kv) => {
    const limit = 3;
    const window = 60_000;

    for (let i = 0; i < limit; i++) {
      const result = await rateLimit(kv, "login", "a@b.com", limit, window);
      assertEquals(result.allowed, true);
    }

    const blocked = await rateLimit(kv, "login", "a@b.com", limit, window);
    assertEquals(blocked.allowed, false);
    assertEquals(blocked.remaining, 0);
    assertEquals(blocked.retryAfterSeconds > 0, true);
  });
});

Deno.test("rate limit counts each subject separately", async () => {
  await withTestKv(async (kv) => {
    await rateLimit(kv, "login", "a@b.com", 1, 60_000);
    const blockedA = await rateLimit(kv, "login", "a@b.com", 1, 60_000);
    assertEquals(blockedA.allowed, false);

    // A different person must not be caught by someone else's limit.
    const otherUser = await rateLimit(kv, "login", "c@d.com", 1, 60_000);
    assertEquals(otherUser.allowed, true);
  });
});

Deno.test("findOrCreateUser is idempotent for the same address", async () => {
  await withTestKv(async (kv) => {
    const first = await findOrCreateUser(kv, "Player@Example.com");
    assertEquals(first.created, true);

    // Different casing must resolve to the same account.
    const second = await findOrCreateUser(kv, "player@example.com");
    assertEquals(second.created, false);
    assertEquals(second.user.id, first.user.id);
  });
});

Deno.test("SUPER_ADMIN_EMAIL is promoted on first login only", async () => {
  await withTestKv(async (kv) => {
    Deno.env.set("SUPER_ADMIN_EMAIL", "owner@example.com");
    try {
      const owner = await findOrCreateUser(kv, "owner@example.com");
      assertEquals(owner.user.role, "super_admin");

      const player = await findOrCreateUser(kv, "someone@example.com");
      assertEquals(player.user.role, "player");
    } finally {
      Deno.env.delete("SUPER_ADMIN_EMAIL");
    }
  });
});

Deno.test("concurrent first logins create exactly one user", async () => {
  await withTestKv(async (kv) => {
    // Two tabs clicking "send me a link" at the same moment.
    const results = await Promise.all([
      findOrCreateUser(kv, "race@example.com"),
      findOrCreateUser(kv, "race@example.com"),
    ]);

    assertEquals(results[0].user.id, results[1].user.id);

    const stored = await getUserByEmail(kv, "race@example.com");
    assertNotEquals(stored, null);
  });
});
