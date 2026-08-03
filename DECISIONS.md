# Decisions

Choices made that the build spec did not dictate, or where the implementation
deliberately departs from it. Newest phase last.

## Phase 1 — Foundation

### Deviations from the spec

**Guest pricing is organizer-set per game, not a fixed divisor.** The spec said
`perHead = ceil(totalCourtCostFils / confirmedCount)` while also saying a guest
is "charged like a normal player" — those contradict whenever a guest attends.
Guest pricing is now a per-game choice of three modes:

| Mode         | Members owe                                | Guest owes       |
| ------------ | ------------------------------------------ | ---------------- |
| `full_share` | `ceil(total / (confirmed + guests))`       | same as a member |
| `flat_fee`   | `ceil((total - guests × fee) / confirmed)` | the fixed fee    |
| `free`       | `ceil(total / confirmed)`                  | nothing          |

**Payment opens at the cutoff, not 72 hours before the game.** The chosen model
is "charge only after the cutoff", so the roster is frozen before anyone pays.
With a 48-hour cutoff the spec's T-72h payment reminder would fire before
payment is even possible. Reminders are therefore T-36h, T-24h and T-3h, and the
organizer fronts the court cost. Revisit if the cutoff is ever set beyond 72
hours.

**Cancellation cutoff default is 48 hours.** The Stitch mockups show 24h; the
spec says 48h. The spec wins, and it is overridable per game.

**Waitlist promotion has a one-hour floor.** The spec's window is "12 hours or
until the cutoff, whichever is sooner", which yields a zero or negative window
once the cutoff has passed. A promoted player now always gets at least an hour,
and inside the final hour before the game the seat is granted outright rather
than left pending.

### Design system

**Tokens come from `smash_club_design_system/DESIGN.md`, not the mockups.** The
mockup `code.html` files use Inter and a `#fff8f0` surface; the design system
specifies Sora + Hanken Grotesk on `#f9fbe7`. The mockups are reused for layout
and copy only. Their Tailwind CDN `<script>`, Google Fonts links and
`lh3.googleusercontent.com` images are all dropped — the PWA has to work
offline, and fonts are self-hosted in `static/fonts/`.

**Dark mode values are new.** The mockups declared `darkMode: "class"` but never
supplied a dark palette.

**Logos.** `BLACK_LOGO_HORIZONTAL.svg` everywhere, `BLACK_LOGO_VERTICAL.svg` on
login and verify, `ICON.svg` for the PWA icon and favicon. They are inlined as
Preact components with brand strokes rewritten to `currentColor`, so one asset
per orientation themes itself. The `NEON_*` variants are unused — their lime is
`#c6eb33`, which does not match the `#C6F432` token. `WORD.svg` is excluded: it
is a ~2 MB raster wrapped in an SVG, not real vector art.

### Storage and runtime

**Photos are 256×256 JPEG, stored in KV.** The spec suggested WebP. Deno has no
2D canvas context — `new OffscreenCanvas().getContext("2d")` returns `null` both
locally and on Deploy — so images are processed with ImageScript (pure WASM),
which has no WebP encoder. JPEG at quality 82 yields ~10 KB for a 256×256
square, far below KV's 64 KiB value cap. ImageScript is imported lazily because
its WASM payload breaks Vite's SSR module runner at boot.

**Known limitation:** Vite's dev server rejects multipart requests containing a
file part with a bare 400 before they reach Fresh, so photo upload cannot be
exercised through `deno task dev`. It works under
`deno task build && deno task
start` and on Deno Deploy, and is covered directly
against the app handler.

**Super admin is seeded from `SUPER_ADMIN_EMAIL`** and promoted on first login,
rather than "first user to sign up wins".

**Sessions roll forward lazily.** A 30-day session is only rewritten once it is
more than seven days old, so a page view does not cost a KV write.

**Rate limiting is a fixed window** backed by a self-expiring KV counter — one
limit per email, one per IP. A sliding window would cost more bookkeeping than
this threat model warrants.

**Group payout IBANs are stored in clear.** They are the group's public
receiving account, shown to every member with a copy button. Only _player
refund_ IBANs are encrypted with AES-256-GCM.

**Stats include a per-group leaderboard** (minimum five confirmed matches),
which the mockups designed and the spec omitted. The mockups' "streak" was cut.

### Deferred

- Recurring game templates, per the spec.
- A service worker. The manifest, icons and offline-capable shell are in place;
  the caching layer lands with the games list in Phase 2, since there is nothing
  to cache until then.

## Phase 2 — Games, RSVP and the waitlist

### Two seat counters, not one

`Game` gained `pendingCount` alongside `confirmedCount`. They answer different
questions and merging them would be wrong:

```
capacity           = confirmedCount + pendingCount + guestCount
cost split divisor = confirmedCount + guestCount
```

A promoted player holds a seat for up to 12 hours before accepting. That seat
has to block other joins — otherwise the promotion means nothing — but it must
not enter the cost divisor. If it did, everyone's estimate would drop the moment
an offer was made and jump back if it lapsed, and `splitCost` would have charged
a share to someone who never accepted.

### Guests are a per-game limit

`Game.maxGuestsPerPlayer` defaults to 1; 0 disables guests. A guest occupies a
real seat, so a player bringing one needs two seats free. A party that does not
fit entirely goes to the waitlist together rather than being split up.

### Skill is advisory, time is not

A player outside a game's skill range sees a warning and may still join —
organizers set ranges loosely and a club game with an empty seat is better
filled. Joining after the game has started is refused outright. Joining after
the cutoff is allowed while seats remain, since the organizer has already paid
for the court.

### An empty game is quoted as "if you join alone"

`splitCost` returns zero when nobody has joined, which is correct — an empty
roster owes nothing — but showing "AED 0 per player" reads as free, at exactly
the moment a new game is most likely to be browsed. `displaySplit` quotes an
empty game as though the viewer had joined, which is the honest answer to "what
would this cost me?".

### Groups exist but only one is used

Phase 2 seeds a single "Smash Club" group on first touch and joins every user to
it. The records are real `Group` and `Membership` rows under the multi-group key
schema, so a second group later is a routing and UI change rather than a
migration. Group CRUD, invites and switching are deferred.

### The queue cannot be un-scheduled

Deno KV has no way to cancel or replace an enqueued message. So:

- Rescheduling is "enqueue another one". A `cutoff_freeze` that fires early
  because the organizer moved the start time notices the cutoff has not arrived,
  re-enqueues itself, and returns.
- Every handler is idempotent, because delivery is at least once. A repeated
  promote finds no free seat; a repeated freeze finds `rosterFrozenAt` already
  set.
- A read-triggered sweep (`lib/data/sweep.ts`) is the backstop for a message
  that never arrives at all. It never blocks a response.

Follow-on messages are enqueued _after_ a commit, never inside a `withRetry`
callback — the callback may run several times, and enqueuing from inside would
post a message per attempt including ones that never committed.

### RSVP is a form POST, with the island only adding feedback

Every action is a plain `<form method="post">` that redirects, so it works with
JavaScript off. `islands/RsvpButton.tsx` adds exactly one thing: the button
disables and changes label on submit. It deliberately does not post JSON or
optimistically flip a seat to "joined" — the server is the only party that knows
which of two simultaneous taps won, and guessing would show a seat that was not
there.

### Bugs found while building this phase

**`withRetry` rejected roughly a quarter of 40 simultaneous joins.** Every
joiner writes the same game record, so they serialize; a writer near the back
legitimately lost more than the 8-attempt budget allowed, and surfaced a
`ConflictError` to a player who had done nothing wrong. Raised to 24 attempts
and capped the backoff, which was growing to most of a second per wait. 100
parallel joins now settle in about 1.1 seconds with nothing rejected.

**`nextSequence` could hand two callers the same number.** It incremented
atomically with `sum` but read the result back with a plain `get`, so a second
increment landing in between gave both callers the same value. Two waitlisted
players would have collided on one index key and one would have vanished from
the queue. It now claims its value under a versionstamp check.

**`.gitignore` excluded the entire data layer.** The pattern `data/` for the
local KV database also matched `lib/data/`, so nine files — every data-layer
module from both phases — were never committed and a fresh clone would not have
built. Now anchored as `/data/`. Verified by cloning the repository and running
the suite from the clone.

## Phase 3 — Payments, reminders, refunds and results

### The cutoff decides the bill, permanently

`freezeRoster` now writes each confirmed signup its own `owedFils` alongside the
game's per-head figure. Per-head alone is not a bill: a player who brought a
guest owes their share plus the guest's, and under `flat_fee` or `free` pricing
that is not a multiple of anything.

Once written the figure never moves. A player joining after the cutoff pays the
frozen rate and reduces nobody else's bill; the organizer absorbs the
difference. The alternative — recomputing as the roster churns — means someone
who has already transferred money can silently become owed a refund, with no
good moment to tell them. "The cutoff decides what you owe" is a rule a player
can act on; "your share may move after you have paid it" is not.

The roster is written in the same atomic operation as the game, so a freeze
locks everything or nothing. A partial freeze would leave some players owing a
figure derived from a split that no longer exists.

### A claim and a confirmation are different facts

`marked_paid` is the player's word, `paid` is the organizer's. The money moves
by bank transfer outside the app, so nothing in it can verify arrival. Keeping
the two apart means a player has a record of having paid before the organizer
reaches their bank statement, and a disagreement is visible rather than hidden.

`settlementFor` counts a claim as **outstanding**, not collected. "How much am I
still out of pocket" is the figure that matters most to an organizer, so it is
the one that must not be optimistic.

A refunded share leaves both the owed and the collected totals. Counting it on
one side only would make the two disagree by exactly the refunded amount.

### Reminders are claimed before they are sent

Queue delivery is at-least-once, so the real problem is not sending an email but
not sending it three times. Each signup claims a `ReminderTag` under a
versionstamp check _before_ its email goes out, so two concurrent deliveries
cannot both win.

That ordering means a send failing after the claim loses a reminder rather than
repeating it. This is the right way round: a missed nudge is a smaller harm than
a mailbox full of duplicates, and the next reminder in the schedule still
arrives.

The schedule is the one Phase 1 settled on — `pay` at the freeze, when a figure
to pay first exists, then T-36h, T-24h and T-3h. Offsets already in the past are
skipped rather than fired late.

### A result counts only when the loser agrees

Anyone on the roster may report a score, which means anyone may report a wrong
one in their own favour. A match starts `pending` and reaches the leaderboard
only once a player on the **losing** side confirms it — letting the winner
confirm their own result would make the pending state decorative. Stats move
only on the commit that actually confirmed, so a duplicate call cannot count one
win twice.

Score validation checks the shape of the claim, not its plausibility. Badminton
scores vary by format, and an organizer correcting a genuine oddity is worse
served by a rule that refuses it. A draw is rejected because there is no such
thing.

### Attendance has three states, not two

`attendedAt` alone cannot distinguish "not marked yet" from "marked absent", and
treating its absence as a no-show would count every unmarked player against
themselves. `markedAbsentAt` is a separate field, mutually exclusive with it.

**Bug found while building this phase:** marking a player absent was a silent
no-op for exactly the players it was meant to record. The guard compared the
requested state against `attendedAt !== undefined`, so "mark absent" on a player
nobody had marked yet compared `false === false` and returned early. Caught by
the no-show test on its first run. Correcting a mark now moves the count between
columns rather than adding to both.

## Phase 4 — Payments, results, attendance and stats in the UI

### The leaderboard is sorted in memory, not indexed

`keys.leaderboard` was defined in Phase 1 and never written. It is now deleted.
Keeping it would mean deleting the old sort-key entry and writing a new one
atomically on every stats change, and a club is tens of players: a prefix scan
and an in-memory sort cost nothing at that size, while an index that must stay
consistent costs attention forever.

`listStats` returns a group's records unsorted. Ordering and the five-match
threshold live in the route, because they are presentation rules — a different
screen may want a different order, and a data function that silently drops rows
is hard to trust.

### A rate with nothing recorded is a dash, not zero

Show-up rate is `attended / (attended + noShow)` and is undefined when both are
zero. Rendering that as 0% would count an organizer's unfinished paperwork
against the player, which is the same mistake the three-state attendance model
exists to avoid.

Players below the qualifying threshold are listed as "still qualifying" rather
than omitted. Being absent from a leaderboard with no explanation reads as a
bug, and the fix costs one extra section.

### The UI hides what the backend refuses

Confirm and dispute controls render only for the losing side; attendance toggles
and the settlement screen only for an organizer. None of that is the control.
`confirmMatch` still rejects a winner who forges the POST, and every organizer
route calls `requireOrganizer` against the game's own group — being an organizer
somewhere is not being an organizer here. The visibility rules are a courtesy so
people are not offered actions that will fail.

Match ids are checked against the game named in the URL before being acted on.
The slug decides whose permissions were verified, so a match id from elsewhere
would otherwise be ruled on under the wrong game's context.

### Bugs found while building this phase

**Organizers could be locked out of their own group.** The shared `begin` helper
seated every actor with `ensureMembership(kv, group.id, user.id)`, which
defaults to the `player` role. Since that function only writes on first touch,
an organizer whose first action was an RSVP got a player membership permanently,
and `requireOrganizer` refused them thereafter. `organizerContext` had always
passed the role; `begin` had not.

**Payment actions were never audited.** `confirmPaid` and `refundPayment`
returned a bare `Response` so they could redirect to the settlement screen
rather than the game page. `act` treats a bare `Response` as a validation
failure that changed nothing and skips the audit entry — so the two actions that
move money left no record of who moved it. An outcome may now carry a `redirect`
without giving up its entry.

## Phase 5 — QR check-in

### Players show, the organizer scans

The direction of the scan is a security decision, not an ergonomic one. The
check-in POST comes from the organizer's browser carrying a token the player
displayed, so `setAttendance` stays organizer-guarded and a player replaying
their own valid token is still refused.

The other direction — one code on the organizer's screen that players scan —
would have meant either dropping that guard or trusting the roster entirely, and
would have made a forwarded screenshot enough to mark yourself present from
home.

### The token expires, and admits that is all it does

`HMAC(APP_SECRET, gameId:userId:window)` over a five-minute bucket, verified
against the current bucket and the previous one. It proves _this player, this
game, recently_ — it does not prove presence, and nothing can.

What it buys is that a code screenshotted the night before is useless, which is
the realistic abuse. A code rotating every few seconds would be stronger on
paper and would trade a marginal gain for clock skew at a venue with bad signal.

### A hand-written QR encoder rather than a dependency

`lib/qr/encode.ts` is byte mode, level M, versions 1–6 — enough for a token with
room to spare and nothing else. A general-purpose library would ship several
hundred kilobytes into a PWA that otherwise sends one small island.

The encoder is tested against verified fixtures rather than against itself,
which is what caught all three bugs in the first draft. Each produced a matrix
with correct finder patterns, correct dimensions, and no readable content:
format bits placed least-significant-first, a reversed generator polynomial, and
a mistyped coordinate near the timing row. An encoder that agrees with itself
proves nothing.

### The scanner has a fallback that predates it

Decoding uses the browser's own `BarcodeDetector`. Where it is absent — Firefox,
older Safari — the island says so and points at the Phase 4 manual toggles
sitting directly below it on the same screen. That is a real fallback rather
than a degraded one: marking the roster by hand was the only method before this
phase, and it still works.

The two live on one screen deliberately. An organizer at a door who has to
change pages to mark the one person whose phone is flat will stop using the
scanner.

### The one JSON endpoint

Every other action in the app is a form POST that redirects. The scan is not:
reloading the page between players would drop the camera stream and the
organizer's place in the queue. A refused code returns a message rather than an
error status page, because a stale screenshot at a door is an ordinary event.

## Phase 6 — More than one club

### The club is in the URL, not in the session

`/g/smash-club/games` rather than a "current club" the session remembers.

The deciding case is how this app is actually shared: an organizer pastes a link
into a WhatsApp group. With the club held in the session, that link resolves
against whatever club the _reader_ last visited — so two people opening the same
message can land on different rosters, and neither has any way to tell. Money
and attendance hang off those pages.

The cost is a bigger diff and longer URLs. The gain is that a link means the
same thing to everyone who opens it, which is the only property that makes a
link worth sharing.

`/games`, `/stats` and `/checkin` survive as redirects rather than being
deleted: old links keep working, and the bottom navigation can stay
club-agnostic. They resolve by membership — straight through for someone in one
club, to the club list for anyone in none or several.

Navigation inside a club page points at that club rather than at the bare paths.
Going through a redirect that resolves against membership would, for someone in
two clubs, quietly move them to the other one.

### A game page stays at /games/:gameSlug

Game slugs are already unique across the whole app and the record carries its
own `groupId`, so putting the club in that URL would have bought nothing and
broken every link already shared.

### Nothing joins anyone to a club

Auto-join was the single-club shortcut: opening any page seated you in the one
club. With two, it would have quietly put everyone in whichever they browsed
first.

Membership now takes an explicit act — an invite link, an organizer adding a
known address, or a request the organizer approves. Three ways in rather than
one, because they fail in different situations: an invite link works for someone
with no account yet, adding by email works when the organizer knows exactly who
they mean, and a request works when the player found the club first.

### A club is private in who plays, not in whether it exists

A signed-in non-member sees a club's public games and is offered the way in. The
alternative — 404 for anyone not already a member — hides the club from exactly
the person an invite link is about to send there, and makes a shared game link a
dead end.

Per-game visibility is unchanged and still means what it did: an unlisted game
404s for a non-member, because keeping it off the listing is a promise that
handing it to anyone who guesses the slug would not honour.

### An invite is marked spent rather than deleted

Magic-link tokens are consumed by deletion, which is right for a login: the link
dies with the session it opened and nobody taps it twice.

An invite lives in a chat thread. Deleting the record on redemption makes a
spent link indistinguishable from a forged one, so the second person to tap it
is told the link is invalid — which reads as a bug in the app rather than as
someone else having taken the place. The record is kept, marked, and left to
expire on its own.

An invite never grants organizer rights. Promotion is a deliberate act on the
members page, never something a forwarded link can do.

### The owner's rights cannot be removed

Not by another organizer, not by themselves. Every other role and block is
reversible by someone; a club whose last organizer has been demoted is not.

### Guarding a game by its club, not just by a role

The organizer handlers found a game by slug and checked organizer rights — but
against the club in the URL, while the game was fetched globally. With one club
those were the same thing. With two, an organizer of one club could reach
another club's roster and money by naming their own club in the URL.

Every organizer route now checks that the game belongs to the club being
administered, and answers 404 rather than 403: a game in someone else's club is
not theirs to know about.

## After the first deployment

### A magic link is confirmed, not consumed, on arrival

`GET /auth/verify` shows a Sign in button; the `POST` behind it spends the
token.

Consuming on `GET` worked for every local test and failed on the first real
email. Mail providers fetch the links in a message before their recipient ever
opens it — to scan for malware, to build a preview — and a single-use token
spent by that fetch is gone by the time its owner clicks. The failure is
particularly bad because it is indistinguishable from the honest case: the user
is told the link has expired, on a link that is seconds old, and asking for
another one produces the same result forever.

Development never showed it. With no `RESEND_API_KEY` the link is printed to the
console, and a console has no scanner.

The alternative — letting a token be redeemed two or three times inside its
window — absorbs the scanner without the extra click, and gives away the
property that makes single use worth having: a link that leaks or is forwarded
inside those fifteen minutes would admit whoever else opens it.

Requests arriving from an inbox carry no CSRF cookie, so the confirmation page
sets one. A refused CSRF check leaves the token unspent, or a forged submission
would be a way to burn someone else's link.

### The stylesheet has to be in the module graph

`assets/styles.css`, imported by `client.ts`, with no `<link>` in the shell.

Tailwind compiles through Vite. A stylesheet sitting in `static/` and named by a
hand-written `<link rel="stylesheet" href="/styles.css">` is invisible to the
module graph, so Vite copies it instead of compiling it: the browser receives
`@import "tailwindcss"`, a `@theme` block it does not understand, and no utility
classes at all. Every page renders as bare HTML — serif text, blue underlined
links, no layout.

Nothing failed on the way to that. The build succeeded, all tests passed, and
the server returned 200 with a stylesheet link pointing at a real file. It was
6KB of design tokens rather than 25KB of compiled rules, and only a browser
could tell.

`routes/app_shell_test.ts` now asserts against the built output: no raw
`@import` in the shipped CSS, several utility classes present, a hashed
filename, and no hardcoded link left in the shell.

The standalone error page keeps every rule inline. It cannot know the hashed
stylesheet's name, and an error page that only renders when the build went well
is an error page that fails exactly when it is needed.

### Sign-in is a code, not a link

Six digits typed into the app, rather than a link tapped in an email.

The link had to go. Mail providers fetch the links in a message before their
recipient ever opens it, and a single-use link is spent by that fetch — the
person it was sent to then gets "this link has expired" on a link that is
seconds old, and asking for another one produces the same result forever.

Confirming rather than consuming on `GET` fixes that, and was the first attempt
here: the link opened a page with a Sign in button, and only the button spent
the token. It works, and it leaves sign-in as two screens and a round trip
through a URL that some clients still rewrite, wrap or truncate. A code has none
of that surface. There is nothing to follow, so nothing can be followed on the
reader's behalf.

Six digits rather than five characters. Digits are unambiguous read aloud and
get a numeric keypad on a phone; five characters mixing letters and digits
invites the O/0 and I/1 confusions precisely when someone is reading a code off
one device onto another.

The trade is that six digits is a million combinations rather than a 32-byte
token's astronomical number, so guessing becomes conceivable. Wrong answers are
counted against the record and the code is destroyed after five, which makes
brute force hopeless while leaving room for a typo. The existing per-address and
per-IP rate limits still sit in front of that.

The record is keyed by the address rather than by the code, because six digits
collide: keying by the code would let two people signing in at once be issued
the same key. Asking again replaces whatever was pending, so an earlier email
stops working rather than leaving two codes live.
