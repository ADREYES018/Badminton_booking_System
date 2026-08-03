/**
 * Route-level tests for the magic-link landing page.
 *
 * The case that matters most is the one that broke in production: mail
 * providers fetch links before their recipient sees them, so following the
 * link must not spend the token.
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
const { issueMagicToken, peekMagicToken } = await import(
  "../../lib/auth/session.ts"
);
const { CSRF_COOKIE, CSRF_FIELD } = await import(
  "../../lib/auth/middleware.ts"
);
const { getUserByEmail } = await import("../../lib/data/users.ts");

const handler = app.handler();
const kv = await getKv();

const CSRF = "test-csrf-token";

function visit(token: string) {
  return handler(
    new Request(`http://localhost:8000/auth/verify?token=${token}`),
  );
}

function submit(token: string, options: { csrf?: string } = {}) {
  const body = new FormData();
  body.set(CSRF_FIELD, options.csrf ?? CSRF);
  body.set("token", token);
  return handler(
    new Request("http://localhost:8000/auth/verify", {
      method: "POST",
      headers: { cookie: `${CSRF_COOKIE}=${CSRF}` },
      body,
    }),
  );
}

async function issue(label: string): Promise<{ token: string; email: string }> {
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const { token } = await issueMagicToken(kv, email);
  return { token, email };
}

Deno.test("following the link does not spend the token", async () => {
  const { token, email } = await issue("scanned");

  // Exactly what a mail provider's scanner does on the way to the inbox.
  const scanned = await visit(token);
  const body = await scanned.text();

  assertEquals(scanned.status, 200);
  assertStringIncludes(body, "Sign in");
  assertStringIncludes(body, email);
  // The token is still there for the person the link was sent to.
  assertEquals((await peekMagicToken(kv, token))?.emailLower, email);
});

Deno.test("a scanned link still signs its owner in afterwards", async () => {
  const { token, email } = await issue("after-scan");

  await visit(token).then((r) => r.body?.cancel());
  const response = await submit(token);
  await response.body?.cancel();

  assertEquals(response.status, 302);
  assertStringIncludes(response.headers.get("location") ?? "", "/profile");
  assertStringIncludes(
    response.headers.get("set-cookie") ?? "",
    "sc_session=",
  );
  // The account exists now, created on redemption.
  assertEquals((await getUserByEmail(kv, email))?.emailLower, email);
});

Deno.test("the confirmation page hands out the CSRF cookie it needs", async () => {
  const { token } = await issue("csrf-cookie");
  const response = await visit(token);
  await response.body?.cancel();

  // The recipient arrives from their inbox with no cookie yet.
  assertStringIncludes(response.headers.get("set-cookie") ?? "", CSRF_COOKIE);
});

Deno.test("signing in spends the token, so a second attempt is refused", async () => {
  const { token } = await issue("single-use");

  const first = await submit(token);
  await first.body?.cancel();
  assertEquals(first.status, 302);

  const second = await submit(token);
  const body = await second.text();
  assertEquals(second.status, 200);
  assertStringIncludes(body, "already been used or has expired");
  assertEquals(await peekMagicToken(kv, token), null);
});

Deno.test("an unknown token is refused on both the page and the form", async () => {
  const visited = await visit("not-a-real-token");
  assertStringIncludes(
    await visited.text(),
    "already been used or has expired",
  );

  const submitted = await submit("not-a-real-token");
  assertStringIncludes(
    await submitted.text(),
    "already been used or has expired",
  );
});

Deno.test("a link with no token at all is refused", async () => {
  const response = await handler(
    new Request("http://localhost:8000/auth/verify"),
  );
  assertStringIncludes(await response.text(), "missing its token");
});

Deno.test("a forged CSRF token cannot sign anyone in", async () => {
  const { token } = await issue("forged");

  const response = await submit(token, { csrf: "not-the-real-token" });
  const body = await response.text();

  assertStringIncludes(body, "went stale");
  // Refusing must not have spent the token: the real owner can still use it.
  assertEquals((await peekMagicToken(kv, token)) !== null, true);
});
