import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  createSession,
  destroyAllSessions,
  destroySession,
  getSession,
  issueMagicToken,
  MAX_CODE_ATTEMPTS,
  peekMagicToken,
  rateLimit,
  readSessionCookie,
  sessionCookie,
  verifyLoginCode,
} from "./session.ts";
import { createUser, findOrCreateUser, getUserByEmail } from "../data/users.ts";
import { setTestEnv, withTestKv } from "../testing/kv_test_helper.ts";
import { keys } from "../kv/keys.ts";

setTestEnv();

const EMAIL = "player@example.com";

Deno.test("a sign-in code is six digits", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);
    assertMatch(code, /^[0-9]{6}$/);
  });
});

Deno.test("the code is stored hashed, never in clear", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);

    const stored = await kv.get(keys.magicToken(EMAIL));
    assertNotEquals(stored.value, null);
    // A database dump must not yield anything that can be typed in.
    assertEquals(JSON.stringify(stored.value).includes(code), false);
  });
});

Deno.test("the right code signs in and names the address it was for", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);
    const result = await verifyLoginCode(kv, EMAIL, code);

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.claim.emailLower, EMAIL);
  });
});

Deno.test("a code works once", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);

    assertEquals((await verifyLoginCode(kv, EMAIL, code)).ok, true);

    const again = await verifyLoginCode(kv, EMAIL, code);
    assertEquals(again.ok, false);
    if (!again.ok) assertEquals(again.reason, "unknown");
  });
});

Deno.test("three concurrent submissions of one code yield exactly one login", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);

    const results = await Promise.all([
      verifyLoginCode(kv, EMAIL, code),
      verifyLoginCode(kv, EMAIL, code),
      verifyLoginCode(kv, EMAIL, code),
    ]);

    assertEquals(results.filter((r) => r.ok).length, 1);
  });
});

Deno.test("a wrong code is refused but leaves the real one usable", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    const refused = await verifyLoginCode(kv, EMAIL, wrong);
    assertEquals(refused.ok, false);
    if (!refused.ok) assertEquals(refused.reason, "wrong");

    // A typo must not cost someone their code.
    assertEquals((await verifyLoginCode(kv, EMAIL, code)).ok, true);
  });
});

Deno.test("a code is destroyed after too many wrong tries", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      const result = await verifyLoginCode(kv, EMAIL, wrong);
      assertEquals(result.ok, false);
      if (!result.ok) assertEquals(result.reason, "wrong", `attempt ${i}`);
    }

    const last = await verifyLoginCode(kv, EMAIL, wrong);
    assertEquals(last.ok, false);
    if (!last.ok) assertEquals(last.reason, "exhausted");

    // Guessing it away must not leave the real code usable either.
    assertEquals(await peekMagicToken(kv, EMAIL), null);
    assertEquals((await verifyLoginCode(kv, EMAIL, code)).ok, false);
  });
});

Deno.test("asking again replaces the pending code", async () => {
  await withTestKv(async (kv) => {
    const first = await issueMagicToken(kv, EMAIL);
    const second = await issueMagicToken(kv, EMAIL);

    // The earlier email must stop working, or two codes are live at once.
    assertEquals((await verifyLoginCode(kv, EMAIL, first.code)).ok, false);
    assertEquals((await verifyLoginCode(kv, EMAIL, second.code)).ok, true);
  });
});

Deno.test("a code belongs to the address it was sent to", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, EMAIL);
    const result = await verifyLoginCode(kv, "someone-else@example.com", code);

    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "unknown");
  });
});

Deno.test("the address is matched regardless of how it is typed", async () => {
  await withTestKv(async (kv) => {
    const { code } = await issueMagicToken(kv, "Player@Example.COM");
    assertEquals(
      (await verifyLoginCode(kv, " player@example.com ", code)).ok,
      true,
    );
  });
});

Deno.test("an address with no code pending is refused", async () => {
  await withTestKv(async (kv) => {
    const result = await verifyLoginCode(kv, "nobody@example.com", "123456");
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "unknown");
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
