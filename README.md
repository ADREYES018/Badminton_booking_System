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

| Task | Purpose |
|---|---|
| `deno task dev` | Vite dev server with hot reload |
| `deno task build` | Production build into `_fresh/` |
| `deno task start` | Serve the production build |
| `deno task test` | Run the test suite |
| `deno task check` | Format, lint and type-check |

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

`lib/kv/keys.ts` is the single source of truth for every KV key. Nothing
outside it builds a key array, so a schema change is one file plus whatever the
type checker flags.

## Conventions

- **Money is integer fils.** 1 AED = 100 fils. No float goes near a total.
- **Timestamps are UTC**, displayed in Asia/Dubai.
- **Every stored record carries `v`** and is upgraded on read by
  `lib/kv/migrate.ts`.
- **Secondary indexes store a pointer**, never a copy of the record.
- **Authorization is checked server-side on every route.** A hidden button is
  not access control.

## Status

Phase 1 (foundation) is complete: magic-link auth, sessions, role guards,
profiles with encrypted refund IBANs, the KV layer, and the PWA shell.

Phases 2–5 — games and RSVP, payments, admin, QR check-in and stats — are
described in `DECISIONS.md` and the build spec.
