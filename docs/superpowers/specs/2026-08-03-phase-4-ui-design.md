# Phase 4 — Payments, results, attendance and stats in the UI

Phase 3 built the payment, match and attendance backend and left it without a
single caller. This phase puts a user interface on top of it, adds the two
backend reads that interface needs, and deletes one key shape that turned out to
be unnecessary.

## Scope

Four user-facing slices, plus one backend addition:

1. A player pays their share, and an organizer settles the game.
2. A player reports a match result, and the losing side confirms or disputes it.
3. An organizer marks who turned up.
4. Everyone sees their own stats and the group leaderboard.

Out of scope: QR check-in (Phase 5), group management (deferred in Phase 2), and
any change to how joining a game works.

## Backend additions

Only two changes below the route layer.

**`listStats(kv, groupId, limit)`** in `lib/data/matches.ts` — scans the
`["stats", groupId]` prefix and returns `PlayerStats[]`. `getStats` reads one
player at a time, which cannot build a leaderboard.

Sorting and the five-match qualifying filter stay in the route, not here. They
are presentation rules: a different screen may want a different order, and a
data function that silently drops rows is one that is hard to trust.

**Delete `keys.leaderboard`** from `lib/kv/keys.ts`. Nothing has ever written it
and, with the leaderboard sorted in memory, nothing will. Maintaining it would
mean deleting the old sort-key entry and writing a new one atomically on every
stats change — real complexity, bought for a group of a few dozen players where
a prefix scan and an in-memory sort are effectively free.

Everything else this phase needs already exists and is tested: `markPaid`,
`confirmPaid`, `refundPayment`, `settlementFor`, `setAttendance`, `reportMatch`,
`confirmMatch`, `rejectMatch`, `listMatchesForGame`, `getStats`.

## File layout

`routes/game.tsx` is already 602 lines and this phase adds three more concerns
to it. It splits:

| File                              | Holds                                                   |
| --------------------------------- | ------------------------------------------------------- |
| `routes/game.tsx`                 | Game detail GET, RSVP POSTs. Exports `begin` and `act`. |
| `routes/game_actions.tsx`         | Payment, result and attendance POSTs.                   |
| `components/PaymentPanel.tsx`     | Payment state and action, presentational.               |
| `components/ResultsPanel.tsx`     | Report form and match list, presentational.             |
| `routes/organizer/settlement.tsx` | Organizer settlement screen.                            |
| `routes/stats.tsx`                | Own stats and group leaderboard.                        |

The two panel components take props and never touch KV, so their branching —
which is where the rules show up — is unit-testable without a database.

`act` and `begin` are exported rather than duplicated. They carry the
`SignupError`-versus-bug distinction that Phase 2 deliberately centralised, and
a second copy is exactly the kind of drift the Phase 3 refactor found in
`confirmMatch`.

## Data flow

Unchanged from Phase 2. Every action is a plain form POST that redirects:

```
form POST → act() → backend call → audit → 303 with ?notice= or ?error=
```

No new island, no JSON endpoint, no client-side state. A `SignupError` comes
back as a readable message on the query string; anything else propagates as a
bug.

## Slice 1 — Payment

### The player's view

Renders on the game detail page, and only when both are true: the game has
frozen (`game.frozenPerHeadFils !== undefined`) and the viewer is confirmed.

Before the freeze there is no bill. The locked decision is "charge only after
cutoff", and `markPaid` enforces it — it refuses when `owedFils` is unset. The
UI does not offer an action the backend will reject.

The figure shown is `signup.owedFils`, not the game's per-head number. A player
who brought a guest owes their own share plus the guest's, and under `flat_fee`
or `free` pricing that is not a multiple of the per-head figure.

One action, chosen by `signup.payment`:

| State         | What the player sees                                     |
| ------------- | -------------------------------------------------------- |
| `unpaid`      | The amount, the payout IBAN, and an "I've paid" button.  |
| `marked_paid` | "Waiting for the organizer to confirm." No button.       |
| `paid`        | A confirmed chip. No button.                             |
| `refunded`    | A refunded chip. No button.                              |
| `forfeited`   | The amount owed, no action — they left after the cutoff. |

`POST /games/:slug/paid` calls `markPaid`.

### The organizer's view

`/organizer/games/:slug/settlement`. Totals from `settlementFor` at the top,
with **outstanding** the most prominent: DECISIONS.md records it as the figure
that must not be optimistic, since `marked_paid` counts as outstanding rather
than collected.

Below, the confirmed roster with each player's owed figure and payment state.
Confirm-paid on any row not already `paid`; refund only on a row that is `paid`,
matching `refundPayment`'s guard that only a confirmed payment can be refunded.

`POST /games/:slug/payments/confirm` and `POST /games/:slug/payments/refund`,
both organizer-guarded, both taking `userId`.

## Slice 2 — Results

Renders on the game detail page below the roster, once the game has started.

### Reporting

Confirmed players see a form: four selects populated from the confirmed roster
(two for side A, two for side B) and two score fields.
`POST
/games/:slug/results` calls `reportMatch`.

The form does not re-implement validation. `reportMatch` already rejects
duplicate players, a draw, negative scores and a reporter who did not play; the
form surfaces those messages through the existing redirect path. Score
plausibility is deliberately not checked, per the Phase 3 decision that
badminton formats vary.

### Confirming

`listMatchesForGame`, newest first. Each row shows both sides, the score and a
status chip.

On a `pending` match, confirm and dispute buttons render **only for a viewer on
the losing side**, computed from `scoreA` and `scoreB`. The winning side sees
"Waiting for the other side to confirm."

This mirrors the backend rule rather than replacing it. `confirmMatch` still
rejects a winner who forges the POST — the UI hiding the button is a courtesy,
not the control.

`POST /games/:slug/results/confirm` and `POST /games/:slug/results/dispute`,
both taking `matchId`.

## Slice 3 — Attendance

Organizer-only toggles on each confirmed roster row, rendered once the cutoff
has passed.

Three states are shown, because three states exist: present, absent, and not yet
marked. The current state renders as active rather than hiding the other button,
so a mis-mark can be corrected — which `setAttendance` supports, moving the
count between columns rather than adding to both.

`POST /games/:slug/attendance` with `userId` and `attended`, passing the game's
`groupId` so the group counters move.

## Slice 4 — Stats

`/stats`, visible to every member.

**Own card** from `getStats`: win rate, show-up rate, matches played.

**Leaderboard** from `listStats`, filtered to `wins + losses >= 5` and sorted by
win rate descending. The five-match minimum is a locked decision.

Players below the threshold are listed separately as "still qualifying" rather
than dropped. A player who cannot find themselves on a leaderboard, with no
explanation, reasonably reads that as a bug.

Show-up rate is `attended / (attended + noShow)`, and is undefined when both are
zero. It renders as "—", never as 0% — an unmarked player has not failed to turn
up.

## Testing

Route tests follow the existing `routes/game_test.ts` style: the POST returns
303, the backend state actually changed, and the wrong actor is refused.

The refusals worth testing explicitly, because each is a rule rather than an
accident:

- A winner cannot confirm their own match.
- A non-organizer cannot confirm a payment or record a refund.
- `markPaid` before the freeze is refused.
- `refundPayment` on an unpaid signup is refused.

Panel components get unit tests for the branching that decides what renders:
payment state → action, losing side → confirm buttons, three attendance states.

`deno task check` and the full suite pass before each commit.

## Delivery

Six commits, each one green:

1. `feat(stats): list a group's stats for the leaderboard` — `listStats`,
   `keys.leaderboard` deleted.
2. `refactor(game): split the RSVP route from its action handlers`.
3. `feat(payments): let a player pay and an organizer settle`.
4. `feat(matches): report a result and confirm it from the game page`.
5. `feat(attendance): mark the roster present or absent`.
6. `feat(stats): own stats and the group leaderboard`.
