# Decisions

Choices made that the build spec did not dictate, or where the implementation
deliberately departs from it. Newest phase last.

## Phase 1 — Foundation

### Deviations from the spec

**Guest pricing is organizer-set per game, not a fixed divisor.**
The spec said `perHead = ceil(totalCourtCostFils / confirmedCount)` while also
saying a guest is "charged like a normal player" — those contradict whenever a
guest attends. Guest pricing is now a per-game choice of three modes:

| Mode | Members owe | Guest owes |
|---|---|---|
| `full_share` | `ceil(total / (confirmed + guests))` | same as a member |
| `flat_fee` | `ceil((total - guests × fee) / confirmed)` | the fixed fee |
| `free` | `ceil(total / confirmed)` | nothing |

**Payment opens at the cutoff, not 72 hours before the game.**
The chosen model is "charge only after the cutoff", so the roster is frozen
before anyone pays. With a 48-hour cutoff the spec's T-72h payment reminder
would fire before payment is even possible. Reminders are therefore T-36h,
T-24h and T-3h, and the organizer fronts the court cost. Revisit if the cutoff
is ever set beyond 72 hours.

**Cancellation cutoff default is 48 hours.** The Stitch mockups show 24h; the
spec says 48h. The spec wins, and it is overridable per game.

**Waitlist promotion has a one-hour floor.** The spec's window is "12 hours or
until the cutoff, whichever is sooner", which yields a zero or negative window
once the cutoff has passed. A promoted player now always gets at least an hour,
and inside the final hour before the game the seat is granted outright rather
than left pending.

### Design system

**Tokens come from `smash_club_design_system/DESIGN.md`, not the mockups.**
The mockup `code.html` files use Inter and a `#fff8f0` surface; the design
system specifies Sora + Hanken Grotesk on `#f9fbe7`. The mockups are reused for
layout and copy only. Their Tailwind CDN `<script>`, Google Fonts links and
`lh3.googleusercontent.com` images are all dropped — the PWA has to work
offline, and fonts are self-hosted in `static/fonts/`.

**Dark mode values are new.** The mockups declared `darkMode: "class"` but
never supplied a dark palette.

**Logos.** `BLACK_LOGO_HORIZONTAL.svg` everywhere, `BLACK_LOGO_VERTICAL.svg` on
login and verify, `ICON.svg` for the PWA icon and favicon. They are inlined as
Preact components with brand strokes rewritten to `currentColor`, so one asset
per orientation themes itself. The `NEON_*` variants are unused — their lime is
`#c6eb33`, which does not match the `#C6F432` token. `WORD.svg` is excluded: it
is a ~2 MB raster wrapped in an SVG, not real vector art.

### Storage and runtime

**Photos are 256×256 JPEG, stored in KV.** The spec suggested WebP. Deno has no
2D canvas context — `new OffscreenCanvas().getContext("2d")` returns `null`
both locally and on Deploy — so images are processed with ImageScript (pure
WASM), which has no WebP encoder. JPEG at quality 82 yields ~10 KB for a
256×256 square, far below KV's 64 KiB value cap. ImageScript is imported lazily
because its WASM payload breaks Vite's SSR module runner at boot.

**Known limitation:** Vite's dev server rejects multipart requests containing a
file part with a bare 400 before they reach Fresh, so photo upload cannot be
exercised through `deno task dev`. It works under `deno task build && deno task
start` and on Deno Deploy, and is covered directly against the app handler.

**Super admin is seeded from `SUPER_ADMIN_EMAIL`** and promoted on first login,
rather than "first user to sign up wins".

**Sessions roll forward lazily.** A 30-day session is only rewritten once it is
more than seven days old, so a page view does not cost a KV write.

**Rate limiting is a fixed window** backed by a self-expiring KV counter — one
limit per email, one per IP. A sliding window would cost more bookkeeping than
this threat model warrants.

**Group payout IBANs are stored in clear.** They are the group's public
receiving account, shown to every member with a copy button. Only *player
refund* IBANs are encrypted with AES-256-GCM.

**Stats include a per-group leaderboard** (minimum five confirmed matches),
which the mockups designed and the spec omitted. The mockups' "streak" was cut.

### Deferred

- Recurring game templates, per the spec.
- A service worker. The manifest, icons and offline-capable shell are in place;
  the caching layer lands with the games list in Phase 2, since there is
  nothing to cache until then.
