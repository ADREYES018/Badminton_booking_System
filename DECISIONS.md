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
