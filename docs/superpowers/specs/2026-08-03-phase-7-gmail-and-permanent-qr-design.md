# Phase 7 — Gmail API email and one permanent QR per player

Two changes that share a goal: let real players use the app. Today mail
reaches exactly one address and a check-in code lives for ten minutes.

## Part 1 — the Gmail API replaces Resend

### Why

Resend's free tier delivers only to the account owner's own address until a
domain is verified. No domain is available, so nobody else can sign in.

The club owns `smashclub.dxb@gmail.com`. The Gmail API sends *as* that account
— mail leaves Google's own servers, signed by Google's own DKIM key for
`gmail.com`.

That alignment is the reason for choosing this over a relay. A relay such as
Brevo verifies the address with a confirmation click and then sends on its own
infrastructure: the `From:` header says `gmail.com`, the DKIM signature and
Return-Path say the relay, and consumer Gmail scores the mismatch down. Since
the player base is mostly Gmail, that mismatch would land sign-in codes in spam
for exactly the people who need them. Sending through Gmail itself makes the
`From:` claim true, so nothing has to be traded away and no domain purchase is
needed to fix deliverability.

The cost is authentication. A relay needs one API key; this needs an OAuth2
client and a long-lived refresh token, obtained once by hand. That token is a
credential with permission to send mail as the club, and is handled as one.

### Scope

All changes live in `lib/email.ts`. Nothing outside it names a provider, so
`magicLinkEmail`, `reminderEmail`, and both call sites
(`routes/auth/login.tsx`, `lib/data/reminders.ts`) are untouched.

### Contract

Two calls per send, because access tokens last an hour and the deployment holds
only the refresh token.

**1. Mint an access token.**

`POST https://oauth2.googleapis.com/token`, form-encoded:

```
client_id, client_secret, refresh_token, grant_type=refresh_token
```

Returns `{access_token, expires_in}`. A failure here returns `400` with
`{error, error_description}` — `invalid_grant` is the revoked-or-expired token,
and is the one worth recognising by name.

The token is cached in module scope and reused until a minute before its
expiry. The minute of margin covers clock skew and the flight time of the send
that follows. A cache miss costs one extra request, so the failure mode is
slowness rather than breakage.

**2. Send.**

`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`

- Header `Authorization: Bearer <access token>`
- Body `{"raw": "<base64url of an RFC 2822 message>"}`
- Success is **200**. The existing `response.ok` test covers it.

`users/me` resolves to whichever account authorised the refresh token, so the
account is pinned by the credential rather than named in the request.

### The MIME message

Unlike a relay's JSON body, Gmail takes a raw message that this code has to
build: a `multipart/alternative` with the plain-text part first and the HTML
part second, because mail clients render the last part they understand.

Two encoding hazards, both silent if missed:

- **Headers must be ASCII.** A subject carrying anything else — a player's
  name, a punctuation mark pasted from a phone — must be RFC 2047 encoded
  (`=?UTF-8?B?<base64>?=`) or the header is mangled. The bodies are declared
  `charset=UTF-8` and sent base64, which sidesteps the same problem for
  content.
- **`raw` is base64*url*,** not standard base64. `+` and `/` must become `-`
  and `_`. Standard base64 fails with an unhelpful parse error.

### Configuration

| Before | After |
|---|---|
| `RESEND_API_KEY` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| `EMAIL_FROM` default `Smash Club <onboarding@resend.dev>` | `EMAIL_FROM` required, no default |

`EMAIL_FROM` keeps the `Name <addr@host>` format and is written straight into
the `From:` header. A bare address with no angle brackets takes the name
`Smash Club`.

It must name the account that authorised the refresh token. Gmail silently
rewrites a `From:` it does not recognise as an alias of that account, so a
wrong value here does not fail — it sends under the real address instead. That
is worth stating because it is the one misconfiguration in this part with no
error message attached.

The default is removed rather than replaced. Any default would be an address
Gmail would rewrite, which is a silent wrong answer where an unset variable can
raise a loud one naming itself.

The no-credential console fallback is unchanged in behaviour, but its trigger
moves: with `GMAIL_REFRESH_TOKEN` unset the message is logged, so local
development needs no Google project and tests never post to the network.

### Errors

`EmailError` keeps its shape, its `isConfiguration` split, and its `reason`
accessor. Google returns `{error: {code, message}}` on a send failure and
`{error, error_description}` on a token failure; the existing `reason` accessor
already falls back through `parsed?.error?.message` and the raw body, so both
are readable without changing it.

One case earns its own message. A refresh token that has been revoked, or that
expired because the OAuth consent screen was left in Testing, comes back as
`invalid_grant` — which reads as an authentication bug and is really a
configuration one. It is surfaced as such, naming the consent screen, because
the fix is in the Google Cloud console rather than in the code.

### Tests

`lib/email_test.ts` — assertions naming the provider, the endpoint, and the
request shape are replaced. New cases cover what this transport adds and the
old one did not have: base64url encoding with no `+` or `/`, a non-ASCII
subject surviving as an encoded header, the text part preceding the HTML part,
and `invalid_grant` reading as a configuration error.

Message-content tests for `magicLinkEmail` and `reminderEmail` are unchanged
because neither function changes.

### Setup, outside the code

This is the part that is genuinely more work than an API key. It is done once.

1. `smashclub.dxb@gmail.com` — the club's own account. Replies and bounces land
   there rather than on a personal address
2. Google Cloud console, signed in **as that account** → create a project
3. APIs & Services → Library → enable **Gmail API**
4. OAuth consent screen → External → add `smashclub.dxb@gmail.com` as a test
   user → scope `https://www.googleapis.com/auth/gmail.send` only. That scope
   sends and cannot read, which is the whole point of choosing it
5. **Publishing status → In production.** Not optional. A consent screen left
   in Testing expires its refresh tokens after **seven days**, and mail stops
   with no warning and no error until something sends. Google may show an
   unverified-app warning during consent, which is expected and can be clicked
   through for an account authorising its own project
6. Credentials → OAuth client ID → **Desktop app**. This gives a client that
   can complete the flow against `http://localhost` without hosting anything
7. Run the consent flow once, granting from `smashclub.dxb@gmail.com`, and keep
   the `refresh_token` from the response. Request `access_type=offline` and
   `prompt=consent`, or Google returns an access token with no refresh token —
   the single most common way this step goes wrong
8. On Deno Deploy set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
   `GMAIL_REFRESH_TOKEN`, and
   `EMAIL_FROM="Smash Club <smashclub.dxb@gmail.com>"`
9. Send a real sign-in code to a phone that is not yours and confirm it arrives
   in the inbox

The refresh token is a credential that can send mail as the club indefinitely.
It belongs in Deno Deploy's environment settings and nowhere else — not in the
repository, and not in a `.env` file that could be committed.

### Limits

Consumer Gmail allows roughly 500 recipients a day. Sign-in codes and game
reminders for a club of this size are far below that, but a reminder fan-out to
every member of every game counts against it, and it is the ceiling to
remember if the club grows or if reminders ever go daily.

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

`routes/game_actions.tsx`, the `POST /games/:slug/checkin` handler. Four gates
in order:

1. `requireOrganizer(auth, game.groupId)` — unchanged, and still the primary
   access control. The POST comes from the organizer's browser, so a player
   replaying their own code cannot mark themselves.
2. `verifyCheckinToken(token)` — a forged code is rejected. It proves the
   server minted this code for this player at this version, and nothing more.
3. **New:** load the user and reject unless `claim.version` equals
   `checkinVersionOf(player)`. Verification alone cannot do this — the token is
   self-describing, so a superseded code still verifies as its own old version.
   Only the stored record says which version is current. A user id with no
   record is refused here too, rather than checked in anonymously.
4. **New:** load the signup for `(game.id, claim.userId)` and reject unless its
   status is `confirmed`, with "… is not on the roster for this game."

Gate 4 is the one doing the work that expiry used to do. Previously the game
travelled inside the token, so a code could not be presented at a game it was
not minted for. Now that it can be, the roster is what refuses it.

Gate 3 is what makes "replace my code" mean anything.

### Residual risk, stated plainly

A permanent code is worth screenshotting and players will screenshot it.

With gate 4 in place, a leaked code only helps someone already confirmed on
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
- a club member's code for a game they never signed up to is rejected — this
  case already exists and keeps its name; what changes is that the roster now
  refuses it rather than the game inside the token
- a code the player has since replaced is rejected
- the player page renders exactly one code regardless of game count

The existing "a code minted for another game is refused" is deleted. A token
carries no game, so there is no such thing to refuse.
