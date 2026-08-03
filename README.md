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

With no `GMAIL_REFRESH_TOKEN` set, emails are printed to the console — the
six-digit sign-in code appears there, so no Google project is needed in
development.

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
  auth/         Sessions, sign-in codes, CSRF, role guards
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

**4. Set the environment.** `APP_URL` must be the real origin: check-in QR
payloads and invite links are built from it, and a deployment without it refuses
to start rather than handing out links pointing at localhost.

| Variable              | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `APP_URL`             | `https://<your-app>.deno.dev`                                                   |
| `APP_SECRET`          | from `genkey`, mark as secret                                                   |
| `IBAN_ENC_KEY`        | from `genkey`, mark as secret                                                   |
| `SUPER_ADMIN_EMAIL`   | your address — promoted to platform owner on login                              |
| `GMAIL_CLIENT_ID`     | from the OAuth client, see below                                                |
| `GMAIL_CLIENT_SECRET` | from the OAuth client, mark as secret                                           |
| `GMAIL_REFRESH_TOKEN` | from the consent flow, mark as secret                                           |
| `EMAIL_FROM`          | **required**, and must name the Gmail account that authorised the refresh token |
| `KV_PATH`             | **unset** — Deploy provides its own                                             |

**5. Email.** Without `GMAIL_REFRESH_TOKEN` the app logs sign-in codes to the
server console instead of sending them, which on a deployment means nobody can
sign in.

Mail goes out through the Gmail API as the club's own account, so it leaves
Google's servers signed by Google's DKIM key for `gmail.com` and the `From:`
claim is true. A relay would be one API key instead of an OAuth client, but it
signs as itself while claiming a `gmail.com` `From:`, and consumer Gmail scores
that mismatch down — which puts sign-in codes in spam for a player base that is
mostly on Gmail.

Set up once, signed in **as the club's Gmail account**:

1. Create the account itself, e.g. `smashclub.dxb@gmail.com`. Replies and
   bounces land there rather than on a personal address.
2. Google Cloud console → create a project.
3. APIs & Services → Library → enable the **Gmail API**.
4. OAuth consent screen → External → add the club account as a test user → scope
   `https://www.googleapis.com/auth/gmail.send` and nothing else. That scope
   sends and cannot read, which is the point of choosing it.
5. **Publishing status → In production.** Not optional. A consent screen left in
   Testing expires its refresh tokens after **seven days**, and mail then stops
   with no warning and no error until something tries to send. Google may show
   an unverified-app warning during consent; that is expected and can be clicked
   through for an account authorising its own project.
6. Credentials → OAuth client ID → **Desktop app**. That gives a client which
   can complete the flow against `http://localhost` without hosting anything.
7. Run the consent flow once, granting from the club account, and keep the
   `refresh_token` from the response. The authorisation request must carry
   `access_type=offline` **and** `prompt=consent`, or Google returns an access
   token with no refresh token at all — the single most common way this step
   goes wrong.
8. Set the three `GMAIL_*` variables on Deno Deploy, along with:

```
EMAIL_FROM="Smash Club <smashclub.dxb@gmail.com>"
```

`EMAIL_FROM` has no default. It must name the account that authorised the
refresh token: Gmail silently rewrites a `From:` it does not recognise as an
alias of that account, so a wrong value here does not fail — it sends under the
real address instead, with no error attached.

The refresh token can send mail as the club indefinitely. It belongs in Deno
Deploy's environment settings and nowhere else — not in the repository, and not
in a `.env` file that could be committed.

Consumer Gmail allows roughly 500 recipients a day. Sign-in codes and game
reminders for a club this size are far below that, but a reminder fan-out to
every member of every game counts against it.

**6. Sign in once** with `SUPER_ADMIN_EMAIL` to claim platform ownership, then
create a club from `/groups`.

## Status

All six phases are complete:

- **Phase 1** — passwordless auth, sessions, role guards, profiles with
  encrypted refund IBANs, the KV layer, and the PWA shell.
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
