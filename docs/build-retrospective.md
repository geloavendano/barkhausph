# Barkhaus — Build Retrospective & Efficiency Playbook

> Analysis of how this platform was built (and debugged), distilled into what to change
> for the rest of this project and what to set up on day one of the next one.
> Written June 2026, after the migration of admin to React and the stabilization sprint.

## 1. Where the time actually went

Reviewing the build history, almost every multi-round debugging session traces back to
one of six root causes — not to feature complexity:

| # | Root cause | Incidents it produced |
|---|-----------|------------------------|
| 1 | **Business logic duplicated across surfaces** (pricing & availability live in `booking.js`/`pricing.js`, again in `admin-src/lib/pricing.js`, again in the test suite) | Hotel priced by pet size instead of cage type in admin; daycare extra-hours missing in admin; slot logic divergence (unassigned-overflow, service_date) |
| 2 | **No single schema/contract source** — selects hand-assembled per page, semantics undocumented | `convenience_fee` removal broke two pages; `booking_date` (creation date) vs `service_date` (appointment) confusion broke calendar, availability, and check-in independently; the edit-form prepopulation saga (pickup_hour, vaccines naming, waivers, room name, member code) was ~6 separate fixes for one missing mapper |
| 3 | **Silent failure patterns** — `catch {}` "non-fatal" wrappers and soft-fail RLS writes | The auth token deadlock presented as "no data, no errors anywhere"; an INSERT-only RLS policy let charge DELETEs fail silently → duplicated `booking_charges` (real money-data corruption, caught only by the test suite's totals check) |
| 4 | **Built bundles committed to the repo + a CI bot that also commits them** | Merge conflicts on every hashed asset; one bot build raced a fix and reverted source (calendar default tab regression that "kept coming back") |
| 5 | **Production as the only environment** | Demo bookings, RLS changes, and webhook testing all against live data; slot-fill tests require careful cleanup SQL |
| 6 | **Ad-hoc DDL** (dashboard changes outside migrations) | Phantom duplicate FK + stale PostgREST schema cache (HTTP 300 embeds); the RLS policy gap itself |

What did **not** cost meaningful time: the stack choices themselves. Static + Supabase +
edge functions + PayMongo proved cheap, fast, and adequate. The architecture is right;
the *engineering hygiene around change* is what needs upgrading.

## 2. What worked — keep doing these

- **DB-driven configuration** (`pricing` table): price changes without deploys, one
  hydration guard protecting both frontends.
- **Idempotent webhook + pending-hold + cron auto-cancel**: the payment lifecycle has
  been robust in production.
- **Single-use walk-in tokens**: simple, effective gate for the fee-free flow.
- **Token-cache auth pattern** and the 6-second auth watchdog (after the deadlock fix).
- **Living test artifacts**: `docs/test-scenarios.md` + the test console. The
  booking-totals consistency check (S10) caught real data corruption — proof that
  cheap invariants pay for themselves.
- **Debugging inputs**: exact console errors, network traces, and schema dumps pasted
  early collapsed multi-hour hunts into minutes (the `42703`, `JWT expired`, and
  `PGRST201` reports were each solved in one round).
- **Batch-audit requests** ("check if other fields are also missing") — one audit fixed
  six latent bugs at once. Asking for the audit beats reporting symptoms one by one.

## 3. Changes for THIS project (priority order)

1. **`CLAUDE.md` / `CONVENTIONS.md` at repo root** — build commands, deploy steps, and
   the gotcha list (booking_date semantics, bare-hour times, `!inner` embeds, NOTIFY
   pgrst, timezone rules). Highest leverage-per-hour: every future session (human or
   AI) stops rediscovering these.
2. **Move the admin build to CI** (GitHub Actions → Pages artifact). Stop committing
   `/admin/`; delete the bot's write path. Eliminates root cause #4 entirely.
3. **One shared booking contract**: a single module exporting the booking SELECT
   strings, the row→form mapper, and the pricing/availability functions — consumed by
   admin pages and (eventually) the public flow. Eliminates #1 and most of #2.
4. **Error policy**: replace silent `catch {}` with surfaced errors (toast + console)
   and add Sentry (free tier) to both frontends. A silent prod failure should be
   impossible by default.
5. **Migrations-only DDL** from now on (`supabase/migrations/`, applied via CLI, ending
   with `NOTIFY pgrst`). Already started; make it a rule.
6. **Scheduled integrity check**: nightly SQL (or edge cron) asserting
   charges-sum = subtotal, no orphan detail rows, no duplicate base_service lines —
   alert on drift instead of discovering it during testing.
7. **Staging Supabase project + seed script** (the SQL-tools fills, made into a
   `seed.sql`) so destructive testing never touches production again.
8. **ESLint in CI** with `react/no-unstable-nested-components` (the focus-loss class),
   plus `supabase gen types` for typed table access in admin-src.
9. **GA4 funnel events** on booking steps — business measurement, zero risk.

## 4. Day-one template for FUTURE projects

Start every comparable build with:

- **Contracts first**: schema in migrations from commit #1; generated types; one shared
  business-logic package; a one-page data dictionary (especially *date semantics*).
- **Two environments** (prod + staging w/ seeds) and **CI that builds artifacts** —
  never commit build output, never let bots commit to source paths.
- **Error tracking and loud failures from day one** — silent catch is opt-in per case
  with a comment, never the default.
- **A living scenario matrix + smoke E2E** (Playwright headless against staging)
  before the feature count grows past ~3 flows.
- **Docs as a styled HTML family** (functional spec / technical doc / ops guide) kept
  in `docs/` and updated with the change that invalidates them.
- Re-use the proven patterns: DB-driven config, idempotent webhooks, pending-hold +
  auto-cancel, single-use tokens, soft deletes, token-cache auth.

## 5. Collaboration protocol (human ↔ AI sessions)

- Open bug reports with: exact error text, network request + response, schema of the
  table involved. (Every fast fix in this project's history started that way.)
- Prefer "audit everything in this area" over serial symptom reports.
- When a side-quest stalls (e.g. OS-level screenshot plumbing), park it explicitly with
  a fallback decision recorded — exactly what was done, correctly, with the capture
  pipeline.
- After any incident, append the root cause to the gotchas table in
  `docs/technical-doc.html` §12 — that table is the institutional memory.
