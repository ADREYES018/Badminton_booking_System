# Phase 7: Gmail API Email and Permanent QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let real players sign in (the Gmail API replaces Resend) and carry one permanent check-in QR code instead of one short-lived code per game.

**Architecture:** Two independent changes. The email swap stays entirely inside `lib/email.ts`, which already hides the provider from every caller. It sends as `smashclub.dxb@gmail.com` through Google's own servers, so DKIM aligns with the `From:` domain and sign-in codes reach Gmail inboxes rather than spam. The QR change replaces a token carrying `gameId.userId.window.mac` with one carrying `userId.version.mac` — no game, no expiry — and moves the per-game check from the token into a confirmed-roster lookup in the scanner's route handler.

**Tech Stack:** Deno, Fresh 2, Preact, Deno KV, `@std/assert` for tests.

**Spec:** `docs/superpowers/specs/2026-08-03-phase-7-gmail-and-permanent-qr-design.md`

## Global Constraints

- Deno + Fresh 2. Tests run with `deno task test`; lint, format and typecheck run with `deno task check`. Both must pass before any commit.
- Tests never hit the network. `lib/email.ts` logs to the console when `GMAIL_REFRESH_TOKEN` is unset, and that path must survive this change. Every function that would make a request is either not called by the tests or tested through a stubbed `fetch`.
- Comments explain *why*, not *what*. Match the density and voice of the surrounding files — the existing headers in `lib/domain/checkin.ts` and `lib/email.ts` are the reference.
- The check-in MAC keeps `MAC_LENGTH = 16` hex characters and reuses `hmacHex` / `timingSafeEqual` from `lib/crypto.ts`.
- The signed string for a check-in token is exactly `checkin:v2:${userId}:${version}`. The `v2` lives inside the signed bytes.
- No new dependencies. Google is called with `fetch`, not with `googleapis` or any other SDK. `@std/encoding/base64url` is already available and is used rather than hand-rolling the alphabet swap.
- `EMAIL_FROM` has no default. Unset is an error at send time.
- Nothing logs the refresh token, the client secret, or an access token. `EmailError` carries response bodies, so a message that would echo a credential is trimmed before it is thrown.

---
### Task 1: The Gmail API replaces Resend in the mail transport

**Files:**
- Modify: `lib/email.ts:1-8` (header), `:13` (endpoint), `:44-46` (`fromAddress`), `:48-77` (`sendEmail`), `:79-115` (`EmailError`)
- Test: `lib/email_test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `sendEmail(message: EmailMessage): Promise<void>` — unchanged signature. `parseSender(value?: string): {name: string, email: string}`, `encodeHeader(value: string): string`, and `buildMime(message: EmailMessage): string` exported for tests. `EmailError` keeps `status`, `detail`, `isConfiguration`, `reason`.

Callers in `routes/auth/login.tsx:202` and `lib/data/reminders.ts:105` are untouched. `magicLinkEmail` and `reminderEmail` are untouched.

**Before starting:** the Google Cloud setup in the spec's "Setup, outside the code" is a prerequisite for Task 5 only. This task is written and tested with no credentials present — the console fallback covers local development.

- [ ] **Step 1: Write the failing tests**

Add to `lib/email_test.ts`. Keep every existing test — `appUrl` and the three `EmailError` cases still pass unchanged.

The file's existing `withEnv` takes a synchronous body. The send tests are async, so add an async twin beside it rather than changing the original, which three passing tests already use:

```ts
/** As `withEnv`, for bodies that await. */
async function withEnvAsync(
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) before.set(name, Deno.env.get(name));

  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}
```

Then the cases:

```ts
import {
  buildMime,
  encodeHeader,
  parseSender,
  sendEmail,
} from "./email.ts";
import { decodeBase64Url } from "@std/encoding/base64url";

Deno.test("a sender in Name <addr> form splits into a name and an address", () => {
  assertEquals(parseSender("Smash Club <play@example.com>"), {
    name: "Smash Club",
    email: "play@example.com",
  });
});

Deno.test("a bare address still sends, under the club's name", () => {
  assertEquals(parseSender("play@example.com"), {
    name: "Smash Club",
    email: "play@example.com",
  });
});

Deno.test("surrounding whitespace never reaches the provider", () => {
  assertEquals(parseSender("  Smash Club  <  play@example.com  >  "), {
    name: "Smash Club",
    email: "play@example.com",
  });
});

Deno.test("an unset EMAIL_FROM names the variable rather than sending as the wrong address", () => {
  withEnv({ EMAIL_FROM: undefined }, () => {
    // Gmail silently rewrites a From it does not recognise as an alias of the
    // authorising account, so a default here would be a wrong answer with no
    // error attached.
    assertThrows(() => parseSender(), Error, "EMAIL_FROM");
  });
});

Deno.test("an ASCII subject is left alone", () => {
  // Encoding everything would be correct but unreadable in a mail log.
  assertEquals(encodeHeader("Your Smash Club code"), "Your Smash Club code");
});

Deno.test("a non-ASCII subject is encoded rather than mangled", () => {
  const encoded = encodeHeader("Café badminton");

  assertStringIncludes(encoded, "=?UTF-8?B?");
  assertStringIncludes(encoded, "?=");
  // The raw character must not survive: headers are ASCII-only and a mail
  // server is free to strip or replace anything else.
  assertEquals(encoded.includes("é"), false);
});

Deno.test("the plain-text part precedes the HTML part", () => {
  // Clients render the last part they understand, so this order is what makes
  // HTML win where it is supported and text work where it is not.
  const mime = buildMime({
    to: "player@example.com",
    subject: "Test",
    html: "<p>Rich</p>",
    text: "Plain",
  });

  assertEquals(mime.indexOf("text/plain") < mime.indexOf("text/html"), true);
  assertStringIncludes(mime, "multipart/alternative");
  assertStringIncludes(mime, "player@example.com");
});

Deno.test("with no refresh token the message is logged instead of sent", async () => {
  const lines: string[] = [];
  const realInfo = console.info;
  console.info = (...args: unknown[]) => void lines.push(args.join(" "));

  try {
    await withEnvAsync({ GMAIL_REFRESH_TOKEN: undefined }, async () => {
      await sendEmail({
        to: "player@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
      });
    });
  } finally {
    console.info = realInfo;
  }

  assertStringIncludes(lines.join("\n"), "player@example.com");
});

Deno.test("a send posts base64url, which has no plus or slash in it", async () => {
  const realFetch = globalThis.fetch;
  let sentRaw = "";

  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();

    if (url.includes("oauth2")) {
      return Promise.resolve(
        Response.json({ access_token: "test-token", expires_in: 3600 }),
      );
    }

    sentRaw = JSON.parse(init!.body as string).raw;
    return Promise.resolve(Response.json({ id: "sent" }));
  };

  try {
    await withEnvAsync({
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
      GMAIL_REFRESH_TOKEN: "refresh",
      EMAIL_FROM: "Smash Club <play@example.com>",
    }, async () => {
      await sendEmail({
        to: "player@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
      });
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // Standard base64 fails here with an unhelpful parse error from Google.
  assertEquals(sentRaw.includes("+"), false);
  assertEquals(sentRaw.includes("/"), false);
  assertStringIncludes(
    new TextDecoder().decode(decodeBase64Url(sentRaw)),
    "player@example.com",
  );
});

Deno.test("a revoked refresh token reads as configuration, not as a network fault", () => {
  // invalid_grant is what a revoked token and a consent screen left in Testing
  // both look like, and the fix for either is in the Google Cloud console.
  const rejected = new EmailError(
    400,
    JSON.stringify({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }),
  );

  assertEquals(rejected.isConfiguration, true);
  assertStringIncludes(rejected.reason, "revoked");
});
```

Note the fetch stub restores the real `fetch` in a `finally`. A test that leaves it replaced makes every later test in the file lie.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `deno task test lib/email_test.ts`
Expected: FAIL — `parseSender`, `encodeHeader` and `buildMime` are not exported from `lib/email.ts`.

- [ ] **Step 3: Rewrite the transport**

In `lib/email.ts`, replace the file header, the endpoint constant, `fromAddress`, and `sendEmail`.

```ts
/**
 * Transactional email, wrapped so the rest of the app never touches Google
 * directly.
 *
 * With no GMAIL_REFRESH_TOKEN set, messages are logged to the console instead
 * of sent — local development needs no Google project, and tests never post to
 * the network.
 *
 * Mail is sent as the club's own Gmail account through Google's own servers,
 * so the DKIM signature aligns with the From domain. A relay would have been
 * one API key instead of an OAuth client, but it signs as itself while
 * claiming a gmail.com From, and consumer Gmail scores that mismatch down —
 * which would land sign-in codes in spam for a player base that is mostly on
 * Gmail.
 *
 * The cost is a refresh token, which is a credential that can send as the club
 * indefinitely. It lives in the environment and is never logged, including
 * inside an EmailError.
 */

import { encodeBase64Url } from "@std/encoding/base64url";
import { formatFils } from "./domain/money.ts";
import { formatGameTime } from "./domain/time.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
```

Replace `fromAddress` with `parseSender`:

```ts
/**
 * Splits `EMAIL_FROM` into a display name and an address.
 *
 * There is deliberately no default. Gmail rewrites a From header it does not
 * recognise as an alias of the authorising account, so a fallback would not
 * fail — it would quietly send under a different address than the one
 * configured, which is worse than refusing.
 */
export function parseSender(
  value: string | undefined = Deno.env.get("EMAIL_FROM"),
): { name: string; email: string } {
  if (!value?.trim()) {
    throw new Error(
      "EMAIL_FROM must be set to the Gmail account that authorised " +
        'GMAIL_REFRESH_TOKEN, in the form "Smash Club <club@gmail.com>".',
    );
  }

  const angled = value.match(/^(.*)<(.+)>\s*$/);
  if (!angled) return { name: "Smash Club", email: value.trim() };

  const name = angled[1]!.trim();
  return { name: name || "Smash Club", email: angled[2]!.trim() };
}

/**
 * RFC 2047 for anything a header cannot carry as-is.
 *
 * Headers are ASCII. A player's name or a character pasted from a phone would
 * otherwise be stripped or replaced somewhere between here and the inbox.
 * Plain ASCII is left alone so an ordinary subject stays readable in a log.
 */
export function encodeHeader(value: string): string {
  // deno-lint-ignore no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(value))}?=`;
}
```

`encodeHeader` needs standard base64, not base64url — RFC 2047 specifies the `B` encoding. Import both:

```ts
import { encodeBase64 } from "@std/encoding/base64";
import { encodeBase64Url } from "@std/encoding/base64url";
```

Then the message builder and the two requests:

```ts
/**
 * The RFC 2822 message Gmail sends verbatim.
 *
 * Text first and HTML second: a client renders the last part it understands,
 * so this order is what makes HTML win where it is supported without losing
 * the plain-text copy where it is not.
 */
export function buildMime(message: EmailMessage): string {
  const sender = parseSender();
  const boundary = `smash-${crypto.randomUUID()}`;
  const body = (content: string) =>
    encodeBase64(new TextEncoder().encode(content));

  return [
    `From: ${encodeHeader(sender.name)} <${sender.email}>`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body(message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * A live access token, minted from the refresh token and reused until it is
 * nearly stale.
 *
 * Access tokens last an hour and the deployment holds only the refresh token,
 * so without this cache every message would cost two requests. The minute of
 * margin covers clock skew and the flight time of the send that follows.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET") ?? "",
      refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "",
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    // The body here describes the grant, never the credentials that were
    // sent, so it is safe to carry into the error.
    throw new EmailError(response.status, await response.text());
  }

  const granted = await response.json();
  cached = {
    token: granted.access_token,
    expiresAt: Date.now() + (granted.expires_in - 60) * 1000,
  };

  return cached.token;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!Deno.env.get("GMAIL_REFRESH_TOKEN")) {
    console.info(
      `\n[email] to=${message.to}\n[email] subject=${message.subject}\n${message.text}\n`,
    );
    return;
  }

  const response = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodeBase64Url(buildMime(message)) }),
  });

  if (!response.ok) {
    throw new EmailError(response.status, await response.text());
  }
}
```

In `EmailError`, update the class comment and the constructor message, and teach `reason` the one case worth naming:

```ts
  constructor(status: number, detail: string) {
    super(`Gmail rejected the message (${status}): ${detail}`);
```

In the `reason` accessor, before the existing `parsed?.message` lookup:

```ts
      // A refresh token that was revoked, or that expired because the OAuth
      // consent screen was left in Testing, arrives as invalid_grant. That
      // reads as an authentication bug and is really a configuration one, and
      // the fix is in the Google Cloud console rather than in this code.
      if (parsed?.error === "invalid_grant") {
        return `${
          parsed.error_description ?? "The refresh token is no longer valid"
        } — re-authorise GMAIL_REFRESH_TOKEN, and check the OAuth consent screen is set to In production rather than Testing.`;
      }
```

The existing fallback chain already reads `parsed?.error?.message`, which is the shape a send failure returns. Leave it.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `deno task test lib/email_test.ts`
Expected: PASS, including the pre-existing `appUrl` and `EmailError` tests.

- [ ] **Step 5: Confirm no caller referenced the old variable**

Run: `grep -rn "RESEND\|BREVO" --include="*.ts" --include="*.tsx" --include="*.md" . | grep -v node_modules`
Expected: hits only in `docs/`. Any hit in `lib/`, `routes/` or `islands/` is a miss — fix it before committing.

- [ ] **Step 6: Update the deployment docs**

In `README.md`, replace the `RESEND_API_KEY` row with `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN`, and change the `EMAIL_FROM` row to say it is required and must name the Gmail account that authorised the refresh token.

Reproduce the numbered setup list from the spec's "Setup, outside the code" section. Two points must survive the copy, because both fail silently: the consent screen has to be **In production** or refresh tokens expire after seven days, and the authorisation request needs `access_type=offline` with `prompt=consent` or Google returns no refresh token at all.

- [ ] **Step 7: Run the full suite and commit**

```bash
deno task check && deno task test
git add lib/email.ts lib/email_test.ts README.md
git commit -m "$(cat <<'EOF'
feat(email): send through the Gmail API so mail reaches every player

Resend's free tier delivers only to the account owner until a domain is
verified, so nobody else could sign in.

Sending as the club's own Gmail account through Google's servers means
the DKIM signature aligns with the From domain. A relay would have been
one API key rather than an OAuth client, but it signs as itself while
claiming a gmail.com From, and consumer Gmail scores that mismatch down
— which would put sign-in codes in spam for a player base that is
mostly on Gmail.

EMAIL_FROM loses its default. Gmail rewrites a From it does not
recognise as an alias of the authorising account, so a default would not
fail; it would quietly send under a different address than the one
configured.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The check-in token drops its game and its expiry

**Files:**
- Modify: `lib/domain/checkin.ts` — whole file
- Modify: `lib/types.ts:36-54` (the `User` interface)
- Test: `lib/domain/checkin_test.ts` — rewritten

**Interfaces:**
- Consumes: `hmacHex`, `timingSafeEqual` from `lib/crypto.ts` — unchanged.
- Produces:
  - `mintCheckinToken(userId: string, version?: number): Promise<string>`
  - `verifyCheckinToken(token: string): Promise<CheckinClaim>` where `CheckinClaim` is `{userId: string, version: number}`
  - `checkinVersionOf(user: User): number`
  - `CheckinError` — unchanged class
  - `CHECKIN_WINDOW_SECONDS` and `windowAt` are **deleted**. Nothing outside this file used them; Step 5 verifies that.

Task 3 consumes `verifyCheckinToken` and `checkinVersionOf`. Task 4 consumes `mintCheckinToken` and `checkinVersionOf`.

- [ ] **Step 1: Add the version field to the user record**

In `lib/types.ts`, inside `interface User`, after the `role` line:

```ts
  /**
   * Bumped to retire a leaked check-in code. Absent means 1, so no existing
   * record needs migrating.
   */
  checkinVersion?: number;
```

- [ ] **Step 2: Write the failing tests**

Replace the whole body of `lib/domain/checkin_test.ts` below its imports. Keep the `APP_SECRET` line and the dynamic import — both are load-order sensitive.

```ts
/**
 * What a check-in token accepts and what it refuses.
 *
 * Each refusal gets its own case, because they fail for different reasons and
 * a single "invalid token" test would pass while three of the four checks
 * were missing.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));

const {
  CheckinError,
  checkinVersionOf,
  mintCheckinToken,
  verifyCheckinToken,
} = await import("./checkin.ts");

const USER = "user-xyz";

Deno.test("a minted token reads back as its own claim", async () => {
  const token = await mintCheckinToken(USER);
  assertEquals(await verifyCheckinToken(token), { userId: USER, version: 1 });
});

Deno.test("the same player mints the same code every time", async () => {
  // This is the whole point of the phase: one code a player can save to their
  // photo roll and use at every game, rather than one per game per ten minutes.
  assertEquals(await mintCheckinToken(USER), await mintCheckinToken(USER));
});

Deno.test("a tampered signature is refused", async () => {
  const token = await mintCheckinToken(USER);
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");

  await assertRejects(
    () => verifyCheckinToken(tampered),
    CheckinError,
    "could not be verified",
  );
});

Deno.test("a code minted for one player cannot be re-pointed at another", async () => {
  const token = await mintCheckinToken(USER);
  const swapped = token.replace(USER, "user-someone-else");

  await assertRejects(
    () => verifyCheckinToken(swapped),
    CheckinError,
    "could not be verified",
  );
});

Deno.test("bumping the version retires the old code", async () => {
  const leaked = await mintCheckinToken(USER, 1);
  const replacement = await mintCheckinToken(USER, 2);

  assertEquals((await verifyCheckinToken(replacement)).version, 2);
  // The old code still verifies as version 1. It is the caller comparing that
  // against the user's stored version that retires it — see the route test.
  assertEquals((await verifyCheckinToken(leaked)).version, 1);
});

Deno.test("a Phase 5 token is refused before any signature is computed", async () => {
  // Four parts, not three. Old codes cannot survive the format change.
  await assertRejects(
    () => verifyCheckinToken("game-abc.user-xyz.5901234.deadbeefdeadbeef"),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("a malformed token is refused", async () => {
  await assertRejects(
    () => verifyCheckinToken("nonsense"),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("a non-numeric version is refused", async () => {
  await assertRejects(
    () => verifyCheckinToken(`${USER}.two.deadbeefdeadbeef`),
    CheckinError,
    "not a check-in code",
  );
});

Deno.test("a user record without the field reads as version 1", () => {
  // Every user predating this phase is in exactly this state.
  assertEquals(checkinVersionOf({ id: USER } as never), 1);
  assertEquals(checkinVersionOf({ id: USER, checkinVersion: 4 } as never), 4);
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `deno task test lib/domain/checkin_test.ts`
Expected: FAIL — `checkinVersionOf` is not exported, and `mintCheckinToken` still takes a game id first.

- [ ] **Step 4: Rewrite the token**

Replace the whole of `lib/domain/checkin.ts`:

```ts
/**
 * Check-in tokens.
 *
 * A player displays one of these; the organizer's scanner reads it and posts
 * it. The token proves *this player* — it does not prove presence, because
 * nothing can, and a design claiming otherwise would be lying about what it
 * knows.
 *
 * One code per player, for every club and every game, forever. Phase 5 minted
 * one per game and expired it in minutes, which meant a code could not be
 * presented at a game it was not minted for. Nothing in the token enforces
 * that now, so the caller does: `POST /games/:slug/checkin` refuses a player
 * who is not confirmed on that game's roster. That check is what replaced
 * expiry, and without it this token would mark anyone present anywhere.
 *
 * A permanent code is worth screenshotting and will be screenshotted. The
 * version field is the remedy: bumping it retires one player's code without
 * touching anyone else's, where rotating the server secret would kill every
 * code at once.
 *
 * The organizer guard on `setAttendance` remains the actual access control.
 * These functions are pure and hold no KV handle, so the rules here can be
 * tested without a database.
 */

import { hmacHex, timingSafeEqual } from "../crypto.ts";
import type { User } from "../types.ts";

/** How many hex characters of the HMAC the token carries. */
const MAC_LENGTH = 16;

export class CheckinError extends Error {}

/** A record written before this phase has no version and counts as the first. */
export function checkinVersionOf(user: User): number {
  return user.checkinVersion ?? 1;
}

async function sign(userId: string, version: number): Promise<string> {
  // `v2` is inside the signed bytes, so no Phase 5 token can verify here even
  // by accident.
  const mac = await hmacHex(`checkin:v2:${userId}:${version}`);
  return mac.slice(0, MAC_LENGTH);
}

/**
 * The permanent code for one player.
 *
 * The user id travels in the clear. It is not a secret — every member can see
 * the roster — and carrying it means the scanner can name the player before
 * the server replies.
 */
export async function mintCheckinToken(
  userId: string,
  version = 1,
): Promise<string> {
  const mac = await sign(userId, version);
  return `${userId}.${version}.${mac}`;
}

export interface CheckinClaim {
  userId: string;
  version: number;
}

/**
 * Reads a token back, or refuses it.
 *
 * A valid claim means the code was minted by this server for this player at
 * this version. It says nothing about which game, or whether the version is
 * still current — the caller holds the user record needed to answer that.
 */
export async function verifyCheckinToken(
  token: string,
): Promise<CheckinClaim> {
  const parts = token.trim().split(".");
  // Phase 5 tokens carried four parts. Rejecting on count refuses them before
  // any signature is computed.
  if (parts.length !== 3) {
    throw new CheckinError("That is not a check-in code.");
  }

  const [userId, versionText, mac] = parts as [string, string, string];

  const version = Number(versionText);
  if (!Number.isInteger(version) || version < 1) {
    throw new CheckinError("That is not a check-in code.");
  }

  const expected = await sign(userId, version);
  if (!timingSafeEqual(mac, expected)) {
    throw new CheckinError("That code could not be verified.");
  }

  return { userId, version };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `deno task test lib/domain/checkin_test.ts`
Expected: PASS, nine cases.

Then confirm the deleted exports had no other callers:

Run: `grep -rn "windowAt\|CHECKIN_WINDOW_SECONDS" --include="*.ts" --include="*.tsx" . | grep -v node_modules`
Expected: no output. Any hit must be resolved before committing.

- [ ] **Step 6: Commit**

`deno task check` will report type errors in `routes/checkin.tsx` and `routes/game_actions.tsx` — both still call the old signature and are fixed in Tasks 3 and 4. Commit the unit-tested core now and let those tasks restore the build.

```bash
git add lib/domain/checkin.ts lib/domain/checkin_test.ts lib/types.ts
git commit -m "$(cat <<'EOF'
feat(checkin): one permanent code per player, replacing per-game codes

A code carried a game and expired in ten minutes, so a player attending
two games saw two codes and a stale page showed a dead one. It now
carries only the player, and never expires.

Expiry was doing real work: it stopped a code being presented at a game
it was not minted for. The roster check in the scanner's route takes
that job over, and the version field retires a leaked code without
rotating the secret every player depends on.

Callers are updated in the commits that follow.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The roster check replaces expiry at the scanner

**Files:**
- Modify: `routes/game_actions.tsx:202-245` (the `POST /games/:slug/checkin` handler) and its imports at `:29`
- Test: `routes/checkin_test.ts`

**Interfaces:**
- Consumes: `verifyCheckinToken`, `checkinVersionOf`, `CheckinError` from Task 2. `getSignup(kv, gameId, userId): Promise<Signup | null>` and `getUser(kv, userId): Promise<User | null>`, both already imported in this file or in easy reach.
- Produces: no new exports. The route's JSON contract is unchanged: `200 {ok: true, userId, name}` or `400 {ok: false, error}`. `islands/CheckinScanner.tsx` needs no change.

- [ ] **Step 1: Write the failing tests**

Work inside `routes/checkin_test.ts`, which already has the helpers this needs — `gameWithPlayer()`, `signIn(user)`, and `post(path, auth, fields)`. Use them; do not hand-roll `new Request`. Note `gameWithPlayer` returns `player` as a `User` object, not an id.

First, three edits to what is already there:

1. Every call site becomes `mintCheckinToken(player.id)` — the game argument is gone. There are five.
2. **Delete** `"a code minted for another game is refused"`. The token no longer carries a game, so the behaviour it tests cannot exist. Its replacement is the roster test below, which is the same protection relocated.
3. `"a code for someone not on the roster is refused"` already exists and already covers the roster gate. Keep it as-is rather than adding a second one — after step 1 above it exercises the new token against the new gate, which is exactly the case. Only its comment needs updating, to say the roster is now the sole thing refusing this:

```ts
Deno.test("a code for someone not on the roster is refused", async () => {
  // The token is genuine and the scanner is a real organizer. Before this
  // phase the game inside the token refused this; now the roster does.
  const { game, organizer } = await gameWithPlayer();
```

Then add `getUser` and `updateUser` to the dynamic imports at the top:

```ts
const { getUser, updateUser } = await import("../lib/data/users.ts");
```

Then add two new cases. Attendance is read through `attendedAt`, the way every existing test in this file reads it — there is no `attended` field on a signup.

```ts
Deno.test("a code carrying no game still marks a confirmed player present", async () => {
  // The same protection the deleted per-game test gave, now proved through a
  // token that names only the player.
  const { game, player, organizer } = await gameWithPlayer();
  const auth = await signIn(organizer);

  const response = await post(`/games/${game.slug}/checkin`, auth, {
    token: await mintCheckinToken(player.id),
  });

  assertEquals(response.status, 200);
  assertEquals((await response.json()).userId, player.id);
  assertEquals(
    typeof (await getSignup(kv, game.id, player.id))?.attendedAt,
    "string",
  );
});

Deno.test("a superseded code is refused after the player replaces it", async () => {
  const { game, player, organizer } = await gameWithPlayer();

  const leaked = await mintCheckinToken(player.id, 1);
  await updateUser(kv, player.id, { checkinVersion: 2 });

  const auth = await signIn(organizer);
  const response = await post(`/games/${game.slug}/checkin`, auth, {
    token: leaked,
  });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.ok, false);
  assertEquals(
    (await getSignup(kv, game.id, player.id))?.attendedAt,
    undefined,
  );
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `deno task test routes/checkin_test.ts`
Expected: FAIL — `updateUser` rejects `checkinVersion` (added in Step 3) and the handler still passes a game id to `verifyCheckinToken`.

- [ ] **Step 3: Let `updateUser` carry the version**

In `lib/data/users.ts`, add to `interface ProfileUpdate`:

```ts
  checkinVersion?: number;
```

and inside `updateUser`, alongside the other field assignments:

```ts
    if (update.checkinVersion !== undefined) {
      next.checkinVersion = update.checkinVersion;
    }
```

- [ ] **Step 4: Rewrite the handler**

In `routes/game_actions.tsx`, replace the doc comment above the handler and the body of the `try` block.

Two deliberate changes to what is there now. `getUser` moves from after `setAttendance` to before it, because the version check needs the record. And the `player?.name ?? "Player"` fallback goes: a code that verifies against a user id with no record means the account was deleted, which is a refusal rather than an anonymous check-in.

```tsx
  /**
   * Scanning a code.
   *
   * Four gates, in order: the scanner must be an organizer of this game's
   * club, the code must verify, its version must still be the player's
   * current one, and the player must be confirmed on this game's roster.
   *
   * The last is load-bearing. The code carries no game and never expires, so
   * without a roster check a code scanned anywhere would mark its owner
   * present anywhere.
   *
   * The version gate cannot live in verification: a superseded code still
   * verifies as its own old version, and only the stored record knows which
   * version is current.
   *
   * The organizer guard is what makes the direction of the scan safe — the
   * POST comes from the organizer's browser carrying a token the player
   * displayed, so a player replaying their own token still cannot mark
   * themselves.
   */
```

```tsx
    try {
      const token = form.get("token")?.toString() ?? "";
      const claim = await verifyCheckinToken(token);

      const player = await getUser(kv, claim.userId);
      if (!player) {
        throw new CheckinError("That code belongs to no one.");
      }

      // A code the player has replaced is dead, whoever is holding it.
      if (claim.version !== checkinVersionOf(player)) {
        throw new CheckinError(
          "That code has been replaced. Ask for the current one.",
        );
      }

      const signup = await getSignup(kv, game.id, claim.userId);
      if (signup?.status !== "confirmed") {
        throw new CheckinError(
          `${player.name} is not on the roster for this game.`,
        );
      }

      await setAttendance(kv, game.id, claim.userId, true, {
        groupId: game.groupId,
      });

      await audit(kv, {
        actorId: context.user.id,
        action: "signup.attendance_overridden",
        targetId: game.id,
        groupId: game.groupId,
        ip: clientIp(ctx.req),
      });

      return reply(200, {
        ok: true,
        userId: claim.userId,
        name: player.name,
      });
    } catch (error) {
```

Update the import at `:29` and make sure `getSignup` and `getUser` are imported in this file:

```tsx
import {
  CheckinError,
  checkinVersionOf,
  verifyCheckinToken,
} from "../lib/domain/checkin.ts";
```

If `getSignup` is not already imported from `../lib/data/signups.ts`, add it to that import. `getUser` is already imported for the reply.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `deno task test routes/checkin_test.ts`
Expected: PASS, including the pre-existing organizer-guard tests.

- [ ] **Step 6: Commit**

`deno task check` still reports an error in `routes/checkin.tsx`, fixed in Task 4.

```bash
git add routes/game_actions.tsx routes/checkin_test.ts lib/data/users.ts
git commit -m "$(cat <<'EOF'
fix(checkin): refuse a code from someone not on this game's roster

The token no longer carries a game, so nothing in it stops a code being
presented at a game its owner never signed up to. The roster check does
that, and it refuses a version the player has replaced.

A leaked code now buys only what a confirmed player could already have:
being marked present without turning up. Expiry never stopped that
either.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: One code on the page, and a way to replace it

**Files:**
- Modify: `routes/checkin.tsx` (player branch, roughly `:133-170` and `:243-260`)
- Modify: `components/CheckinCode.tsx`
- Modify: `routes/profile.tsx` (form section and the `POST /profile` handler)
- Test: `routes/checkin_test.ts`

**Interfaces:**
- Consumes: `mintCheckinToken(userId, version)` and `checkinVersionOf(user)` from Task 2. `updateUser(kv, userId, {checkinVersion})` from Task 3.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `routes/checkin_test.ts`:

`seedGame` returns `{game, organizer, groupId}` and no slug, so the page test resolves the group through `getGroup`. It also mints its own organizer per call, which is why the second game is seeded separately and the player joins both.

```ts
Deno.test("the check-in page shows one code however many games are open", async () => {
  const { game: first, groupId, player } = await gameWithPlayer();
  const second = await seedGame(kv, { courts: 1, playersPerCourt: 4 });
  await joinGame(kv, second.game.id, player);

  const group = (await getGroup(kv, groupId))!;
  const { cookie } = await signIn(player);

  const response = await handler(
    new Request(`http://localhost:8000/g/${group.slug}/checkin`, {
      headers: { cookie },
    }),
  );

  const html = await response.text();
  assertEquals(response.status, 200);
  // One QR, not one per game.
  assertEquals(html.split('role="img"').length - 1, 1);
});

Deno.test("replacing a code retires the previous one", async () => {
  const player = await seedPlayer(kv);
  const before = checkinVersionOf((await getUser(kv, player.id))!);

  const auth = await signIn(player);
  const response = await post("/profile", auth, { replaceCheckinCode: "1" });
  await response.body?.cancel();

  assertEquals(response.status < 400, true);
  assertEquals(checkinVersionOf((await getUser(kv, player.id))!), before + 1);
});
```

Add `checkinVersionOf` to the dynamic import of `../lib/domain/checkin.ts`, and add `const { getGroup } = await import("../lib/data/groups.ts");` alongside the other dynamic imports.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `deno task test routes/checkin_test.ts`
Expected: FAIL — the page renders one QR per game, and `/profile` ignores `replaceCheckinCode`.

- [ ] **Step 3: Render one code on the check-in page**

In `routes/checkin.tsx`, change `PlayerProps` and `PlayerView`:

```tsx
interface PlayerProps {
  user: User;
  token: string;
  games: Game[];
}

function PlayerView(props: PlayerProps) {
  return (
    <div class="flex flex-col gap-6 max-w-3xl mx-auto">
      <h1 class="text-headline-lg font-headline text-on-surface">Check in</h1>

      <CheckinCode token={props.token} />

      {props.games.length === 0
        ? (
          <EmptyState title="Nothing to check into yet">
            Your code still works. Games appear here once their rosters close.
          </EmptyState>
        )
        : (
          <Card class="flex flex-col gap-3">
            <h2 class="text-body-lg font-bold text-on-surface">
              Ready to check into
            </h2>
            <ul class="flex flex-col divide-y divide-outline-variant">
              {props.games.map((game) => (
                <li key={game.id} class="flex flex-col gap-0.5 py-3">
                  <a
                    href={`/games/${game.slug}`}
                    class="text-body-md font-bold text-on-surface hover:text-primary transition-colors"
                  >
                    {game.title}
                  </a>
                  <p class="text-label-sm text-on-surface-variant">
                    {formatGameTime(game.startUtc, game.endUtc)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
    </div>
  );
}
```

Replace the player branch of the route handler — the `codes` loop goes away:

```tsx
    const games = (await listGamesByGroup(kv, group.id))
      .filter(isOpenForCheckin)
      .sort((a, b) => b.startUtc.localeCompare(a.startUtc));

    // Only the games this player is actually on, so the list matches what the
    // scanner will accept.
    const mine: Game[] = [];
    for (const game of games) {
      const signup = await getSignup(kv, game.id, user.id);
      if (signup?.status === "confirmed") mine.push(game);
    }

    // One code, whatever is on the list. It does not depend on the games.
    const token = await mintCheckinToken(user.id, checkinVersionOf(user));

    return await render(
      <Page user={user} nav="checkin" groupSlug={group.slug}>
        <PlayerView user={user} token={token} games={mine} />
      </Page>,
    );
```

Update the import to bring in `checkinVersionOf` alongside `mintCheckinToken`.

- [ ] **Step 4: Correct the copy on the code itself**

In `components/CheckinCode.tsx`, the header comment's claim about expiry is now false. Replace the second paragraph of the comment:

```tsx
/**
 * A player's check-in code.
 *
 * Rendered server-side as inline SVG, so it costs no client JavaScript and
 * appears with the page rather than after it. One code per player, the same
 * at every game — worth saving to a photo roll, which is the point.
 *
 * The token is printed underneath as text. A camera that will not focus, a
 * cracked screen, or a phone at 1% are all more common at a badminton court
 * than any of them are in a design review, and an organizer who can type a
 * few characters is not blocked by any of them.
 */
```

And the line under the heading:

```tsx
        <p class="text-label-sm text-on-surface-variant text-center">
          Show this at the door. It is the same code at every game.
        </p>
```

- [ ] **Step 5: Add the replace action to the profile page**

In `routes/profile.tsx`, add a section to the rendered form — its own `<form>`, so it does not submit the profile fields:

```tsx
        <Card class="flex flex-col gap-3">
          <h2 class="text-body-lg font-bold text-on-surface">
            Check-in code
          </h2>
          <p class="text-body-md text-on-surface-variant">
            Your QR code never expires, so anyone you have sent a screenshot to
            still has a working copy. Replacing it kills the old one.
          </p>
          <form method="post" action="/profile">
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <input type="hidden" name="replaceCheckinCode" value="1" />
            <Button type="submit" variant="secondary">
              Replace my check-in code
            </Button>
          </form>
        </Card>
```

In the `POST /profile` handler, immediately after the CSRF check and before the name validation — the rest of the handler validates profile fields this form does not carry:

```tsx
    if (form.get("replaceCheckinCode")) {
      // The id comes from the session, never from the form: a player may only
      // retire their own code.
      const replaced = await updateUser(kv, user.id, {
        checkinVersion: checkinVersionOf(user) + 1,
      });

      return await renderProfile(ctx, {
        user: replaced,
        csrf,
        setup,
        notice: "Your check-in code has been replaced.",
      });
    }
```

`ProfileViewProps` currently carries `saved?: boolean` and `error?: string` and no `notice`. Add `notice?: string` to it rather than reusing `saved`, whose `<Alert tone="success">Profile saved.</Alert>` would be a lie here — nothing about the profile was saved. Render it beside the existing alerts at `routes/profile.tsx:92`:

```tsx
        {props.notice && <Alert tone="success">{props.notice}</Alert>}
```

`Alert` is already imported. Import `checkinVersionOf` from `../lib/domain/checkin.ts`.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `deno task test routes/checkin_test.ts`
Expected: PASS.

- [ ] **Step 7: Run everything**

```bash
deno task check && deno task test
```
Expected: clean, and the full suite green — this is the first task at which the build compiles end to end.

- [ ] **Step 8: Commit**

```bash
git add routes/checkin.tsx components/CheckinCode.tsx routes/profile.tsx routes/checkin_test.ts
git commit -m "$(cat <<'EOF'
feat(checkin): show one code, and let a player replace it

The page minted a QR per open game. It now renders the player's single
permanent code above the list of games it works for.

Replacing the code is on the profile page, because a code that never
expires is one a player may need to retire after sending a screenshot to
the wrong chat. The handler takes the player id from the session, so
nobody can retire anyone else's.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Verify against a running app

Automated tests here are HTTP-level. Phase 6 shipped a visually broken app past a green suite, so this task is manual and is not optional.

- [ ] **Step 1: Build and serve**

```bash
deno task serve:demo
```

- [ ] **Step 2: Check the player's code**

Sign in as a seeded player, open `/checkin`. Confirm: exactly one QR, the copy says it is the same code at every game, and the games listed are ones the player is confirmed on.

- [ ] **Step 3: Confirm the code is stable**

Reload the page. The text token underneath must be identical. Reloading is what proved the old code was ephemeral; here it proves the opposite.

- [ ] **Step 4: Scan it**

On a phone, sign in as the organizer, open `/checkin`, and scan the player's code from the other screen. Expect the player's name and their row flipping to present. This needs a real camera — `BarcodeDetector` has no test double.

- [ ] **Step 5: Check the roster refusal**

Scan the code of a player not signed up for that game. Expect "… is not on the roster for this game."

- [ ] **Step 6: Replace and re-scan**

As the player, replace the code on `/profile`. Scan the *old* screenshot. Expect "That code has been replaced." Then scan the new one and expect success.

- [ ] **Step 7: Send a real email**

This is the step the Google Cloud setup in the spec is a prerequisite for. With `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` and `EMAIL_FROM` all set, request a sign-in code for an address that is not yours — a friend's phone.

Confirm four things, because each fails differently:

1. The code arrives **in the inbox**. Check spam anyway: this is the claim the whole transport choice was made for, and it is the only place it can be tested.
2. The `From:` reads `Smash Club <smashclub.dxb@gmail.com>`. If it shows a different address, `EMAIL_FROM` does not match the authorising account and Gmail rewrote it silently.
3. Open the message's "Show original" in Gmail. `DKIM: PASS` with `domain=gmail.com` is the alignment that made this worth the OAuth setup. Anything else means mail is going out through a path this design did not intend.
4. Send a second message a few minutes later. It exercises the cached access token rather than a fresh one, which is the path every message after the first takes.

Then leave it a week and send one more. A refresh token issued against a consent screen still in Testing expires after seven days, and this is the only way that failure surfaces before players hit it.

- [ ] **Step 8: Commit anything the walkthrough turned up**

No commit if nothing broke.

---

## Notes for whoever executes this

**Tasks 2 and 3 leave the build red on purpose.** `deno task check` fails between them because `routes/checkin.tsx` still calls the old signature. Task 4 closes it. If you are running tasks out of order, run 2, 3, 4 as a block.

**The riskiest change is Task 3, Step 4.** Every gate in that handler is load-bearing now that the token carries neither a game nor an expiry. If a reviewer questions one, the answer is in the spec's "Residual risk" section rather than in the code.

**Nothing in `islands/CheckinScanner.tsx` changes.** It posts what it decodes and shows what the server says. If a task tempts you to edit it, re-read the task.
