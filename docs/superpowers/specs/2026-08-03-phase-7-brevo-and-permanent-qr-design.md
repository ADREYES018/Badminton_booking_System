# Phase 7 — Brevo email and one permanent QR per player

Two changes that share a goal: let real players use the app. Today mail
reaches exactly one address and a check-in code lives for ten minutes.

## Part 1 — Brevo replaces Resend

### Why

Resend's free tier delivers only to the account owner's own address until a
domain is verified. No domain is available, so nobody else can sign in.

Brevo verifies a *single sender address* without DNS — a confirmation click on
an address you already own. Once verified, mail delivers to anyone.

The tradeoff is real and is accepted: sending as a `gmail.com` address whose
DNS we do not control means no SPF or DKIM alignment for that domain, so some
recipients will see the mail in spam. Brevo signs with its own DKIM, but the
`From:` domain stays `gmail.com`, and consumer Gmail publishes `p=none` — mail
is scored down rather than rejected. Gmail-to-Gmail is where that shows most,
which is exactly the player base. Inbox placement cannot be verified from the
codebase and must be tested against a real recipient's spam folder.

A dedicated Gmail account sends first, with a purchased domain to follow.
`EMAIL_FROM` is read at send time and nothing else in the app names the sender,
so moving to the domain is a config change with no code change and no
redeploy of logic.

### Scope

All changes live in `lib/email.ts`. Nothing outside it names a provider, so
`magicLinkEmail`, `reminderEmail`, and both call sites
(`routes/auth/login.tsx`, `lib/data/reminders.ts`) are untouched.

### Contract

`POST https://api.brevo.com/v3/smtp/email`

- Header `api-key: <key>` — not `Authorization: Bearer`
- Body `{sender: {name, email}, to: [{email}], subject, htmlContent, textContent}`
- Success is **201**. The existing `response.ok` test covers it.

### Configuration

| Before | After |
|---|---|
| `RESEND_API_KEY` | `BREVO_API_KEY` |
| `EMAIL_FROM` default `Smash Club <onboarding@resend.dev>` | `EMAIL_FROM` required, no default |

`EMAIL_FROM` keeps the `Name <addr@host>` format and is parsed into Brevo's
split `{name, email}`. A bare address with no angle brackets takes the name
`Smash Club`.

The default is removed rather than replaced. Brevo rejects any sender address
the account has not verified, so a default would be a value that always fails
with a message about verification rather than about configuration. Unset now
raises at send time naming the variable.

The no-key console fallback is unchanged: with `BREVO_API_KEY` unset the
message is logged, so local development needs no account and tests never post
to the network.

### Errors

`EmailError` keeps its shape, its `isConfiguration` split, and its `reason`
accessor. Brevo returns `{code, message}` on failure, which the existing
`parsed?.message` path already reads. Changes are the class comment and the
message text, which names Brevo.

### Tests

`lib/email_test.ts` — update assertions that name the provider, the endpoint,
the auth header, and the request body shape. Message-content tests for
`magicLinkEmail` and `reminderEmail` are unchanged because neither function
changes.

### Setup, outside the code

Now, to unblock players:

1. Create a dedicated Gmail account for the club — not the personal address, so
   replies and bounces land somewhere separate and a spam flag never touches
   personal mail
2. Create a Brevo account
3. Senders → add that address → click the confirmation link Brevo emails to it
4. SMTP & API → generate an API key
5. On Deno Deploy set `BREVO_API_KEY` and
   `EMAIL_FROM="Smash Club <thatnewaddress@gmail.com>"`
6. Send a real sign-in code to a phone that is not yours and check the spam
   folder, not just the inbox

Later, for deliverability:

1. Buy a domain
2. Brevo → Domains → add it, copy the DKIM and SPF records into DNS, wait for
   verification
3. Change `EMAIL_FROM` to `"Smash Club <noreply@yourdomain>"`

Step 3 is the whole migration. No code changes.

## Part 2 — one permanent QR per player

### Why

A code is currently minted per game and expires in five to ten minutes. A
player attending two games sees two codes; a player whose page is stale sees a
dead one. The wanted behaviour is one code per player, used everywhere,
forever.

### Token

Today: `gameId.userId.window.mac`
New: `userId.version.mac`

The MAC signs `checkin:v2:${userId}:${version}`. The `v2` prefix is inside the
signed string so no Phase 5 token can verify under the new rules.

`MAC_LENGTH` stays at 16 hex characters and `hmacHex` / `timingSafeEqual` in
`lib/crypto.ts` are reused unchanged. The token is parsed by splitting on `.`
and requires exactly three parts, so a Phase 5 token — which has four — is
refused before any MAC is computed.

No club and no game travel in the token. One code works across every club the
player belongs to.

No time bucket, so the code never expires.

### Version, and what it buys

`User` gains `checkinVersion?: number`. Absent reads as `1`, so existing user
records need no migration.

The code never expires, but it is replaceable. A player whose code has leaked
bumps their own version; their old code stops verifying and no other player is
affected. Without this the only remedy for a leak is rotating the server HMAC
secret, which kills every player's code at once.

### What verification proves

`verifyCheckinToken(token)` returns `{userId}` or throws `CheckinError`.

That is the whole claim: this code belongs to this player. It does not prove
presence — nothing can — and it no longer proves anything about a game or a
club.

### The roster check replaces expiry

`routes/game_actions.tsx`, the `POST /games/:slug/checkin` handler. Three gates
in order:

1. `requireOrganizer(auth, game.groupId)` — unchanged, and still the primary
   access control. The POST comes from the organizer's browser, so a player
   replaying their own code cannot mark themselves.
2. `verifyCheckinToken(token)` — a forged or superseded code is rejected.
3. **New:** load the signup for `(game.id, claim.userId)` and reject unless its
   status is `confirmed`, with "That player is not on the roster."

Gate 3 is the one doing the work that expiry used to do. Previously the game
travelled inside the token, so a code could not be presented at a game it was
not minted for. Now that it can be, the roster is what refuses it.

### Residual risk, stated plainly

A permanent code is worth screenshotting and players will screenshot it.

With gate 3 in place, a leaked code only helps someone already confirmed on
that game's roster — it lets a no-show be marked present by a friend at the
door. Nothing short of expiry closes that, and expiry is what this phase
deliberately removes. Version bump is the remedy for a code known to have
leaked.

Dropping the club from the token has one further cost: any organizer scanning
any code resolves it to a `userId`, including for a player outside their club.
The roster check still blocks attendance, so the exposure is that an organizer
learns a name. Accepted.

### Pages

`routes/checkin.tsx`, player branch — the `codes` array and the loop that mints
one token per game are deleted. One `CheckinCode` renders above the game list.
Games stay listed so a player sees what they are checked in for.

`components/CheckinCode.tsx` — the line "It refreshes every few minutes" is now
false and becomes "This is your code for every game." The read-aloud text
fallback stays; it matters more now that the code is stable enough to save to a
photo roll.

Profile page — a "Replace my check-in code" action bumps `checkinVersion`,
CSRF-guarded like every other POST. A player may only bump their own version;
the handler reads the id from the session and never from the form.

`islands/CheckinScanner.tsx` — no change. It posts whatever it decodes and
renders whatever the server replies.

### Tests

`lib/domain/checkin_test.ts`, rewritten:

- valid token round-trips to its `userId`
- a tampered MAC is rejected
- a token minted at version 1 is rejected after a bump to 2
- a malformed token is rejected

`routes/checkin_test.ts`:

- a confirmed player's code marks attendance
- a club member's code for a game they never signed up to is rejected
- the player page renders exactly one code regardless of game count
