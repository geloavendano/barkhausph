# Barkhaus — repo guide for AI/dev sessions

Two-branch pet-services platform (Estancia & Eastwood, PHT/UTC+8) at **barkhaus.ph**.
Static frontend on GitHub Pages + Supabase (Postgres/RLS, Auth, Realtime, Storage, Edge
Functions) + PayMongo (payments) + Resend (email) + GA4.

Surfaces: landing (`index.html`), booking wizard (`booking.html` + `booking.js`),
admin SPA (`admin-src/` → served at `/admin/`), 5 edge functions (`supabase/functions/`).

## Commands

| Task | Command |
|---|---|
| Local preview (whole site) | `python3 -m http.server 8788` from repo root (see `.claude/launch.json`) |
| Admin dev server | `cd admin-src && npm run dev` |
| Admin production build | `cd admin-src && npm run build` → outputs to `../admin/` (**committed** — see below) |
| Deploy (everything) | `git push` to `main`; GitHub Pages serves repo content from the branch |
| Edge function deploy | `supabase functions deploy <name>` |
| DB changes | SQL file in `supabase/migrations/`, apply via dashboard/CLI, **then** `NOTIFY pgrst, 'reload schema';` |

## Deployment model

GitHub Pages serves the **repo branch** directly (no build step for the static site).
The built admin SPA in `/admin/` **is committed**. On pushes that touch `admin-src/**`,
`.github/workflows/build-admin.yml` rebuilds `/admin/` and commits it back (concurrency
guard prevents overlapping runs). If you change `admin-src` locally and push, either let
the bot rebuild, or run `npm run build` and commit `/admin/` yourself in the same push to
avoid a follow-up bot commit. `docs/` is publicly served.

## Conventions & hard-won gotchas

- **`bookings.booking_date` = CREATION date.** The appointment date lives in the
  service detail table: `*_details.service_date`, or `hotel_details.checkin_date/
  checkout_date`. All availability, calendar, and check-in logic must key on the
  detail-table date — never on `booking_date`.
- **Times**: hotel/daycare drop-off & pick-up hours are stored as bare hour strings
  (`"14"`); grooming/studio slots as display strings (`"2:00 PM"`). Normalize before
  `<input type=time>` or formatters (see `toHHMM` in AddBookingPanel).
- **Timezones**: `created_at` is UTC; users are PHT (UTC+8). Group/display via local
  Date methods — never string-split ISO timestamps.
- **PostgREST**: filter parents by child columns only via `child!inner(...)`. If two
  FKs link the same tables, embeds 300 — disambiguate `child!fk_name(...)`. After any
  DDL, reload the schema cache (`NOTIFY pgrst, 'reload schema';`).
- **RLS**: admin write policies check `EXISTS (SELECT 1 FROM admin_users WHERE email =
  auth.email())`. Edge functions/webhook use the service role (bypass). Never wrap
  admin DB writes in silent `catch {}` — an INSERT-only policy once corrupted
  `booking_charges` invisibly because deletes soft-failed.
- **Auth (admin)**: Google SSO via Supabase. Never call `supabase.auth.getSession()`
  inside per-request header builders (deadlocks behind token refresh) — use the cached
  token set from `App.jsx` (`setAuthToken` / sync `authHeaders` in `lib/supabase.js`).
- **React**: never define components inside a component (remounts per keystroke →
  input focus loss). Hoist to module scope or call step renderers as plain functions.
- **Pricing**: every rate lives in the `pricing` DB table; both frontends hydrate at
  runtime (`pricing.js`, `admin-src/src/lib/pricing.js` — keep their logic in sync!).
  Hotel price key = **cage type × weekday/weekend** (Fri/Sat/Sun = weekend), not pet
  size. Daycare = base (first 3 h) + per-size hourly extras.
- **Soft deletes everywhere**: resources/blocks via `active=false`, bookings via
  status `cancelled`. Inactive resources must vanish from pickers but historical
  bookings still render their names.
- **Walk-in mode**: gated by single-use `walkin_tokens` minted by the admin FAB;
  convenience fee applies to online checkout only.
- **Emails**: Resend, sent by edge functions only — on payment success (online) or
  immediately (admin/walk-in with owner email). Don't add client-side email sends.

## Where things are documented

- `docs/functional-spec.html` — every feature + business rule
- `docs/technical-doc.html` — architecture, ER + sequence diagrams, **§12 gotchas
  table (append new incidents there)**
- `docs/test-scenarios.md` — scenario matrix / acceptance criteria
- `docs/admin-guide.html` — staff walkthrough (screenshot placeholders pending)
- `docs/build-retrospective.md` — efficiency playbook
- `~/Projects/barkhaus-dev/barkhaus-tests.html` — test console (API asserts, E2E
  console scripts, 270-item manual checklist, SQL seed/cleanup tools)

## Secrets & keys

Supabase anon key is public by design (hardcoded in clients). Real secrets
(`PAYMONGO_SECRET_KEY`, `RESEND_API_KEY`) live only in Supabase function env. Nothing
secret belongs in this repo.
