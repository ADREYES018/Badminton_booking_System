# Smash Club

Badminton game RSVP, payments and check-in for a Dubai club.

Deno · Fresh 2 · TypeScript · Tailwind · Deno KV · Deno Deploy

## Getting started

```bash
deno install                 # fetch dependencies
deno run -A tools/genkey.ts  # generate IBAN_ENC_KEY and APP_SECRET
cp .env.example .env         # then paste the keys in
deno task dev                # http://localhost:5173
```

With no `RESEND_API_KEY` set, emails are printed to the console — the magic-link
sign-in URL appears there, so no mail account is needed in development.

Set `SUPER_ADMIN_EMAIL` to your own address before first sign-in; that account
is promoted to platform owner.

## Tasks

| Task              | Purpose                         |
| ----------------- | ------------------------------- |
| `deno task dev`   | Vite dev server with hot reload |
| `deno task build` | Production build into `_fresh/` |
| `deno task start` | Serve the production build      |
| `deno task test`  | Run the test suite              |
| `deno task check` | Format, lint and type-check     |

Photo upload cannot be exercised under `deno task dev` — see `DECISIONS.md`.

## Layout

```
components/     Preact components; logos inlined from Logos/
routes/         Explicitly registered in main.ts, not file-convention
lib/
  kv/           Key schema, migrate-on-read, atomic retry helper
  domain/       Money, time and validation — the tested core
  data/         Record access per entity
  auth/         Sessions, magic links, CSRF, role guards
static/         Styles, self-hosted fonts, PWA icons
tools/          One-off scripts (key generation, icon rendering)
```

`lib/kv/keys.ts` is the single source of truth for every KV key. Nothing outside
it builds a key array, so a schema change is one file plus whatever the type
checker flags.

## Routes

```
/groups                          Your clubs; create one
/invite/:token                   Redeem an invite link

/g/:club/games                   That club's games
/g/:club/stats                   Its leaderboard
/g/:club/checkin                 Your code, or the organizer's scanner
/g/:club/members                 Roster, roles, blocks, invites  (organizer)
/g/:club/settings                Name, cutoff, payout details    (organizer)
/g/:club/organizer/games/…       Create, edit, cancel, settle    (organizer)

/games/:game                     One game. Slugs are globally unique, and the
/games/:game/…                   record names its own club.

/games  /stats  /checkin         Redirect into your club, for older links
```

## Conventions

- **Money is integer fils.** 1 AED = 100 fils. No float goes near a total.
- **Timestamps are UTC**, displayed in Asia/Dubai.
- **Every stored record carries `v`** and is upgraded on read by
  `lib/kv/migrate.ts`.
- **Secondary indexes store a pointer**, never a copy of the record.
- **Authorization is checked server-side on every route.** A hidden button is
  not access control.
- **A club lives in the URL.** Every club-scoped screen is `/g/:club/…`, so a
  link shared into a chat means the same thing to everyone who opens it. Rights
  are read per club: being an organizer somewhere grants nothing anywhere else.
- **Nobody joins a club by looking at it.** Membership comes from an invite
  link, an organizer adding a known address, or a request an organizer approves.

## Deploying

Built for Deno Deploy, which provides managed KV — leave `KV_PATH` unset there
and `Deno.openKv()` finds the assigned database on its own.

**1. Generate real secrets.** Never reuse the ones in `deno.json`'s demo task.

```bash
deno run -A tools/genkey.ts
```

Keep `IBAN_ENC_KEY` somewhere safe. It decrypts players' stored refund IBANs,
and losing it makes them unreadable for good — there is no recovery path.

**2. Create the app**, from the dashboard or the CLI:

```bash
deno deploy create --org <org> --app smash-club \
  --source github --owner <you> --repo Badminton_booking_System \
  --framework-preset fresh
```

**3. Provision KV and assign it.** This is not automatic.

```bash
deno deploy database provision smash-club-kv --kind denokv --org <org>
deno deploy database assign smash-club-kv --app smash-club
```

**4. Set the environment.** `APP_URL` must be the real origin: every magic link
and QR payload is built from it, and a deployment without it now refuses to
start rather than handing out links pointing at localhost.

| Variable            | Value                                              |
| ------------------- | -------------------------------------------------- |
| `APP_URL`           | `https://<your-app>.deno.dev`                      |
| `APP_SECRET`        | from `genkey`, mark as secret                      |
| `IBAN_ENC_KEY`      | from `genkey`, mark as secret                      |
| `SUPER_ADMIN_EMAIL` | your address — promoted to platform owner on login |
| `RESEND_API_KEY`    | from Resend, mark as secret                        |
| `EMAIL_FROM`        | see below                                          |
| `KV_PATH`           | **unset** — Deploy provides its own                |

**5. Email.** Without `RESEND_API_KEY` the app logs magic links to the server
console instead of sending them, which on a deployment means nobody can sign in.
Resend's `onboarding@resend.dev` needs no domain and no DNS, but only delivers
to the address that owns the Resend account:

```
EMAIL_FROM="Smash Club <onboarding@resend.dev>"
```

That is enough to sign in yourself and walk the whole app on a real phone.
Inviting anyone else means verifying a domain in Resend and pointing
`EMAIL_FROM` at it.

**6. Sign in once** with `SUPER_ADMIN_EMAIL` to claim platform ownership, then
create a club from `/groups`.

## Status

All six phases are complete:

- **Phase 1** — magic-link auth, sessions, role guards, profiles with encrypted
  refund IBANs, the KV layer, and the PWA shell.
- **Phase 2** — games, RSVP, guests and the waitlist.
- **Phase 3** — the cutoff freeze, payments, reminders, refunds, match results
  and attendance.
- **Phase 4** — those last three in the UI: paying a share and settling a game,
  reporting a result and confirming it, marking the roster, and the stats page
  with the group leaderboard.
- **Phase 5** — QR check-in: a player shows a signed, short-lived code and the
  organizer scans it at the door, with the manual toggles on the same screen for
  whoever's phone is flat.
- **Phase 6** — more than one club: every screen lives under `/g/:club/`,
  membership takes an explicit act (an invite link, an organizer adding an
  address, or a request they approve), and organizers get a roster and settings
  to run a club with.
