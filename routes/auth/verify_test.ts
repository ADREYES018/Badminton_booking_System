/**
 * Route-level tests for signing in with a code.
 *
 * Sign-in used to be a link, and mail providers fetch the links in a message
 * before their recipient sees them — a single-use link was routinely spent by
 * that fetch and its owner told it had expired. A code cannot be followed, and
 * the first test here is that nothing about opening the page consumes one.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

// Must be set before main.ts is imported: getKv() caches the handle it opens.
Deno.env.set("KV_PATH", ":memory:");
Deno.env.set("IBAN_ENC_KEY", encodeBase64(new Uint8Array(32).fill(7)));
Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));
Deno.env.set("APP_URL", "http://localhost:8000");

const { app } = await import("../../main.ts");
const { getKv } = await import("../../lib/kv/kv.ts");
const { issueMagicToken, MAX_CODE_ATTEMPTS, peekMagicToken } = await import(
  "../../lib/auth/session.ts"
);
const { CSRF_COOKIE, CSRF_FIELD } = await import(
  "../../lib/auth/middleware.ts"
);
const { getUserByEmail } = await import("../../lib/data/users.ts");

const handler = app.handler();
const kv = await getKv();

const CSRF = "test-csrf-token";

function submit(
  fields: Record<string, string>,
  options: { csrf?: string } = {},
) {
  const body = new FormData();
  body.set(CSRF_FIELD, options.csrf ?? CSRF);
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return handler(
    new Request("http://localhost:8000/auth/verify", {
      method: "POST",
      headers: { cookie: `${CSRF_COOKIE}=${CSRF}` },
      body,
    }),
  );
}

async function issue(label: string): Promise<{ code: string; email: string }> {
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const { code } = await issueMagicToken(kv, email);
  return { code, email };
}

/** Any code that is not the right one. */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

Deno.test("there is no link to follow, so nothing can spend a code early", async () => {
  const { email, code } = await issue("no-get");

  // Whatever a mail provider does with this address, it cannot be a redemption.
  const visited = await handler(
    new Request("http://localhost:8000/auth/verify?code=" + code),
  );
  await visited.body?.cancel();

  assertEquals(visited.status, 302);
  assertStringIncludes(visited.headers.get("location") ?? "", "/auth/login");
  // Still pending for the person it was sent to.
  assertEquals((await peekMagicToken(kv, email))?.emailLower, email);
});

Deno.test("the right code opens a session", async () => {
  const { email, code } = await issue("good");

  const response = await submit({ email, code });
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertStringIncludes(response.headers.get("location") ?? "", "/profile");
  assertStringIncludes(response.headers.get("set-cookie") ?? "", "sc_session=");
  assertEquals((await getUserByEmail(kv, email))?.emailLower, email);
});

Deno.test("a code with spaces around it is still accepted", async () => {
  const { email, code } = await issue("spaced");

  const response = await submit({ email, code: `  ${code} ` });
  await response.body?.cancel();

  assertEquals(response.status, 302);
});

Deno.test("a wrong code returns to the form rather than starting over", async () => {
  const { email, code } = await issue("typo");

  const response = await submit({ email, code: wrongCode(code) });
  const body = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(body, "That code is not right");
  // The form comes back ready for another go, still knowing the address.
  assertStringIncludes(body, `value="${email}"`);

  // And the real code still works.
  const retry = await submit({ email, code });
  await retry.body?.cancel();
  assertEquals(retry.status, 302);
});

Deno.test("too many wrong tries cancels the code", async () => {
  const { email, code } = await issue("guessed");
  const wrong = wrongCode(code);

  for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
    const attempt = await submit({ email, code: wrong });
    await attempt.body?.cancel();
  }

  const last = await submit({ email, code: wrong });
  assertStringIncludes(await last.text(), "Too many wrong tries");

  // The real code is gone too, so guessing cannot be resumed.
  const refused = await submit({ email, code });
  assertStringIncludes(
    await refused.text(),
    "expired or has already been used",
  );
});

Deno.test("a code works once", async () => {
  const { email, code } = await issue("once");

  const first = await submit({ email, code });
  await first.body?.cancel();
  assertEquals(first.status, 302);

  const second = await submit({ email, code });
  assertStringIncludes(
    await second.text(),
    "expired or has already been used",
  );
});

Deno.test("someone else's code does not work for your address", async () => {
  const theirs = await issue("theirs");
  const mine = await issue("mine");

  const response = await submit({ email: mine.email, code: theirs.code });
  assertStringIncludes(await response.text(), "That code is not right");

  // Their code is untouched by the attempt.
  assertEquals((await peekMagicToken(kv, theirs.email))?.attempts, 0);
});

Deno.test("a submission with no address is refused", async () => {
  const response = await submit({ code: "123456" });
  assertStringIncludes(await response.text(), "which address");
});

Deno.test("a forged CSRF token cannot sign anyone in", async () => {
  const { email, code } = await issue("forged");

  const response = await submit({ email, code }, { csrf: "not-the-token" });
  assertStringIncludes(await response.text(), "went stale");

  // Refusing must not have spent the code.
  assertEquals((await peekMagicToken(kv, email))?.emailLower, email);
});
