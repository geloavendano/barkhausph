# Barkhaus - shared repo guide for AI/dev sessions

This file is the shared operating guide for Codex, Claude Code, and human teammates.
Keep durable repo rules here so every teammate sees the same constraints. Tool-specific
notes can live in `CLAUDE.md`, `.codex/`, or other local config, but project behavior
belongs here.

## Collaboration model

- Treat agents as teammates working in the same repo: check current work before editing,
  claim meaningful work in `.agents/BOARD.md`, and leave a short handoff when done.
- Prefer separate branches or worktrees for concurrent agent work. If two teammates need
  the same files, pause and coordinate before editing.
- Do not overwrite or revert changes you did not make unless the human explicitly asks.
- Keep changes scoped. Avoid broad formatting churn unless the task is formatting.
- Update docs when you learn a new Barkhaus-specific gotcha, especially
  `docs/technical-doc.html` section 12.

## Git and commits

- Git commits are allowed for completed, coherent work in this repo.
- Before editing or committing, inspect the branch and working tree. Commit only the files
  you changed for the current task.
- Do not include unrelated untracked files, generated experiments, local secrets, or another
  teammate's edits in your commit.
- Prefer small commits with direct messages, for example `docs: add agent handoff notes` or
  `fix: normalize admin booking dates`.
- If tests or verification could not be run, say that in the handoff and commit message body
  when relevant.

## Supabase boundary

Supabase remote edits are human-operated. Agents may draft code, SQL, migrations, RLS policy
changes, and edge-function updates in the repo, but the human will manually execute:

- Edge function deploys.
- Table/schema changes.
- RLS policy changes.
- Dashboard or CLI operations against the live Supabase project.

When a task needs Supabase action, leave a handoff note with:

- The exact files or SQL involved.
- The intended manual action.
- Whether `NOTIFY pgrst, 'reload schema';` is needed after DDL.
- Any verification that should happen after the human applies it.

## Project overview

Two-branch pet-services platform (Estancia & Eastwood, PHT/UTC+8) at **barkhaus.ph**.
Static frontend (GitHub Pages today; moving to Cloudflare Pages, see Deployment model) + Supabase (Postgres/RLS, Auth, Realtime, Storage, Edge
Functions) + manual transfer payments, dormant Maya Checkout / PayMongo providers,
Resend (email), and GA4.

Surfaces: landing (`index.html`), booking wizard (`booking.html` + `booking.js`),
admin SPA (`admin-src/` -> served at `/admin/`), edge functions (`supabase/functions/`).

## Commands

| Task | Command |
|---|---|
| Local preview (whole site) | `python3 -m http.server 8788` from repo root (see `.claude/launch.json`). **Needs staging settings first** (see Environments), otherwise pages refuse to load data. |
| Admin dev server | `cd admin-src && npm run dev` |
| Admin production build | `cd admin-src && npm run build` -> outputs to `../admin/` (**committed** - see below) |
| Deploy (static site) | `git push` to `main`. GitHub Pages serves the repo as-is today; Cloudflare Pages builds `main` with `sh scripts/build-site.sh` → `dist/` |
| Preview a branch | Push the branch; Cloudflare Pages builds `https://<branch>.barkhausph.pages.dev` against **staging** |
| Edge function deploy | Human manually runs `supabase functions deploy <name>` |
| DB changes | SQL file in `supabase/migrations/`, human applies via dashboard/CLI, then `NOTIFY pgrst, 'reload schema';` |

## Deployment model

**Today:** GitHub Pages serves the `main` branch directly. It publishes the **whole repo**, including
`AGENTS.md`, `supabase/` and `admin-src/`, so treat everything committed as public.

**Moving to (decision: `docs/decisions/2026-09-20-hosting-and-previews.md`):** Cloudflare Pages
(project `barkhausph`) serves production (`main`) and a preview per branch. Its build command is
`sh scripts/build-site.sh`, which:

1. runs `scripts/write-env.sh` to write `env-staging.js` (preview builds only), and
2. copies an **allowlist** of public files into `dist/` (the output folder). Anything not listed there
   (functions, migrations, admin source, agent notes) is never published. Add new public top-level
   folders to that script, or they will 404.

`_headers` holds response headers (noindex for `/admin/` and `/staging/`, admin asset caching).
`404.html` is the not-found page. The DNS move to Cloudflare follows
`docs/decisions/2026-09-20-dns-move-checklist.md` (email records must be copied exactly).

The built admin SPA in `/admin/` **is committed**. On pushes that touch `admin-src/**`,
`.github/workflows/build-admin.yml` rebuilds `/admin/` and commits it back (concurrency
guard prevents overlapping runs). If you change `admin-src` locally and push, either let
the bot rebuild, or run `npm run build` and commit `/admin/` yourself in the same push to
avoid a follow-up bot commit.

`docs/` is publicly served (open question in the hosting decision whether it should stay public).

## Environments (production vs staging)

Every page (public site, `/staging/` pages, admin) loads `/env-staging.js` then `/env.js` before its
own scripts, and reads the Supabase address and anon key from `window.BH_ENV`. **Never hard-code a
Supabase address or key in page code again.**

- `barkhaus.ph`, `www.barkhaus.ph`, `barkhausph.pages.dev` → always **production**, even if staging
  settings are present.
- Anywhere else (branch previews, localhost) → **staging**, from `window.BH_STAGING` in
  `env-staging.js`. With no staging settings, `env.js` throws and the page loads no data. It never
  falls back to production.
- `env-staging.js` is committed as an empty placeholder. Cloudflare preview builds fill it from the
  **Preview** variables `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_ANON_KEY`. These must never be set on
  Production; a `main` build that finds them fails on purpose.
- The staging database is a Supabase preview branch that the human switches on and off with
  `~/Projects/claude-setup/staging/staging.sh up|down|snapshot|previews barkhaus`. `up` also updates
  Cloudflare's preview variables and rebuilds recent previews.
- Local preview against staging: while staging is up, write the local settings file (don't commit it):
  `STAGING_SUPABASE_URL=… STAGING_SUPABASE_ANON_KEY=… sh scripts/write-env.sh`, then
  `git checkout -- env-staging.js` when done. The URL and anon key are in the Supabase dashboard
  (branch `staging` → Project Settings → API).
- The `/staging/` folder is a set of **pages** (new customer account + booking flow) served on the
  same site. It is not the staging environment: on barkhaus.ph those pages use production.

## Conventions and hard-won gotchas

- **`bookings.booking_date` = CREATION date.** The appointment date lives in the
  service detail table: `*_details.service_date`, or `hotel_details.checkin_date/
  checkout_date`. All availability, calendar, and check-in logic must key on the
  detail-table date - never on `booking_date`.
- **Times**: hotel/daycare drop-off and pick-up hours are stored as bare hour strings
  (`"14"`); grooming/studio slots as display strings (`"2:00 PM"`). Normalize before
  `<input type=time>` or formatters (see `toHHMM` in AddBookingPanel).
- **Timezones**: `created_at` is UTC; users are PHT (UTC+8). Group/display via local
  Date methods - never string-split ISO timestamps.
- **PostgREST**: filter parents by child columns only via `child!inner(...)`. If two
  FKs link the same tables, embeds 300 - disambiguate `child!fk_name(...)`. After any
  DDL, reload the schema cache (`NOTIFY pgrst, 'reload schema';`).
- **RLS**: admin policies use `public.is_admin()` (case-insensitive match on
  `admin_users.email`). **Never write `TO authenticated USING (true)`**: "signed in" is not
  "admin". Any Google account can get a session via the admin's sign-in button, and customer
  accounts sign in too (incident 2026-09-20, fixed by
  `20260920120000_restrict_signed_in_access_to_admins.sql`). Edge functions/webhook use the service role (bypass). Never wrap
  admin DB writes in silent `catch {}` - an INSERT-only policy once corrupted
  `booking_charges` invisibly because deletes soft-failed.
- **Auth (admin)**: Google SSO via Supabase. Never call `supabase.auth.getSession()`
  inside per-request header builders (deadlocks behind token refresh) - use the cached
  token set from `App.jsx` (`setAuthToken` / sync `authHeaders` in `lib/supabase.js`).
- **React**: never define components inside a component (remounts per keystroke, causing
  input focus loss). Hoist to module scope or call step renderers as plain functions.
- **Pricing**: every rate lives in the `pricing` DB table; both frontends hydrate at
  runtime (`pricing.js`, `admin-src/src/lib/pricing.js` - keep their logic in sync!).
  Hotel price key = **cage type x weekday/weekend**, not pet size. Fri/Sat/Sun are
  weekend by default, and active rows in `rate_calendar` can override holidays to the
  weekend rate. Daycare = base (first 3 h) + per-size hourly extras.
- **Soft deletes everywhere**: resources/blocks via `active=false`, bookings via
  status `cancelled`. Inactive resources must vanish from pickers but historical
  bookings still render their names.
- **Walk-in mode**: gated by single-use `walkin_tokens` minted by the admin FAB;
  convenience fee applies to online checkout only.
- **Emails**: Resend, sent by edge functions only - on payment success (online) or
  immediately (admin/walk-in with owner email). Do not add client-side email sends.

## Where things are documented

- `docs/functional-spec.html` - every feature + business rule
- `docs/technical-doc.html` - architecture, ER + sequence diagrams, **section 12 gotchas
  table (append new incidents there)**
- `docs/test-scenarios.md` - scenario matrix / acceptance criteria
- `docs/admin-guide.html` - staff walkthrough (screenshot placeholders pending)
- `docs/build-retrospective.md` - efficiency playbook
- `/Users/gelo/Projects/barkhaus-dev/barkhaus-tests.html` - test console (API asserts,
  E2E console scripts, 270-item manual checklist, SQL seed/cleanup tools)

## Secrets and keys

Supabase anon key is public by design (production's lives in `env.js`; see Environments). Real secrets
(`MAYA_PUBLIC_KEY`, `MAYA_SECRET_KEY`, `PAYMONGO_SECRET_KEY`,
`PAYMONGO_WEBHOOK_SECRET`, `RESEND_API_KEY`) live only in Supabase function env.
`MAYA_ENVIRONMENT` is `sandbox` or `production`; customer routing remains controlled
by `PAYMENT_GATEWAY_PROVIDER` in `booking.js` (keep `manual` until launch). Nothing
secret belongs in this repo.
