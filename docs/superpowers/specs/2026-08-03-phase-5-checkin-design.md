# Phase 5 — QR check-in

Phase 3 built attendance and Phase 4 put manual toggles on the roster. This
phase adds the fast path: a player shows a code, the organizer scans down the
line, and the same `setAttendance` call runs per scan.

## Scope

- A confirmed player's own check-in code, on the game page once the roster
  freezes.
- An organizer scanner that decodes those codes and marks players present.
- `/checkin`, which the bottom nav has linked since Phase 1 and which currently
  404s.

Out of scope: rotating codes, offline queueing, and a bundled decode library.
Group management stays deferred.

## Direction: players show, organizer scans

The organizer's browser sends the check-in POST, carrying a token the player
displayed. That matters more than it looks: `setAttendance` is
organizer-guarded, so the guard still holds and **a player cannot mark
themselves present by replaying their own token**. Pointing the scan the other
way — one code on the organizer's screen that players scan — would have meant
either dropping that guard or trusting the roster entirely.

## The token

`lib/domain/checkin.ts`, pure functions with no KV access.

```
payload = gameId "." userId "." window
token   = payload "." HMAC(APP_SECRET, payload) truncated to 16 hex chars
window  = floor(epochSeconds / 300)
```

Verification accepts the current window and the previous one, so a code scanned
as a bucket rolls over still works. A forwarded screenshot stops working within
ten minutes.

The token proves _this player, this game, recently_. It does not prove presence
— nothing can, and a design that claimed to would be lying. What it buys is that
a code shared the night before is useless, which is the realistic abuse.

`lib/crypto.ts` already has `hmacHex` and `timingSafeEqual`; the comparison must
use the latter, since a token check is exactly where a timing leak would matter.

## The QR encoder

`lib/qr/encode.ts`. Byte mode, error correction level M, version chosen by
payload length, rendered as inline SVG with one `<rect>` per dark module.

No dependency is added. The payloads here are short ASCII strings we control, so
a fixed-mode encoder is a bounded amount of code — and the alternative is
shipping a general-purpose library into a PWA that currently ships one small
island.

The encoder is tested against known-good fixtures rather than against itself. An
encoder that is merely self-consistent is one that can be confidently wrong.

## Slices

### A — token domain

`mintCheckinToken` and `verifyCheckinToken`. Refusals tested individually: a
token for another game, an expired window, a tampered MAC, a malformed string.
Plus the boundary where the window rolls over.

### B — QR encoder

Matrix generation and SVG rendering, with fixture-based tests.

### C — the player's code

On the game detail page, for a confirmed player once the roster has frozen.
Shows the QR and the token as text beneath it, so a scan that will not focus has
a fallback the organizer can type.

### D — the scanner

`islands/CheckinScanner.tsx`. Requests the camera, feeds frames to the browser's
`BarcodeDetector`, and POSTs each decoded token. On success it names the player
and keeps scanning — a queue at the door should not need a tap between people.

`BarcodeDetector` is native on Android Chrome and Safari 17+ and absent
elsewhere. Where it is missing the island renders a message pointing at the
manual toggles below it, which already do this job. No decode library is bundled
to cover the gap.

Camera access requires HTTPS or localhost. That is a deployment fact, not
something the code can work around, and the fallback is what covers it.

### E — `/checkin`

One screen for the door:

- The scanner, for the organizer's next frozen game.
- Directly beneath it, the confirmed roster with the Present/Absent toggles
  built in Phase 4, and a present/total count.

Scanning handles most people; the toggles handle whoever's phone is flat. Both
on one screen means the organizer never leaves the scanner to fix a miss.

For a player, the page lists their frozen games and their code for each.

The Phase 4 `AttendanceToggle` and `attendanceOf` move out of `routes/game.tsx`
into `components/Attendance.tsx` so both pages share one copy rather than
growing a second.

## Testing

- Token: each refusal, and the window boundary.
- Encoder: fixtures, not self-consistency.
- Route: a scan marks the player present; a token from another game is refused;
  a player POSTing their own token is refused by the organizer guard.
- The scanner island's decode loop is not unit-tested. It is camera plumbing,
  and the value is in the token and route tests underneath it.

## Delivery

Six commits, each green:

1. `feat(checkin): mint and verify check-in tokens`
2. `feat(qr): encode short payloads as inline SVG`
3. `refactor(attendance): share the roster toggles between pages`
4. `feat(checkin): show a player their code`
5. `feat(checkin): scan codes at the door`
6. `docs: record Phase 5 design decisions`
