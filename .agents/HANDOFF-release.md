# Handoff: Barkhaus release (Cloudflare DNS move + customer accounts + multi-service booking)

Written 2026-10-27 by Claude Code for the next agent. **Nothing in this guide has been executed against
production.** Everything below was verified on 2026-10-26/27 unless marked otherwise. Re-verify (§4)
before acting: state may have moved since.

You will be guiding **Gelo** (the owner) through a release. Gelo runs every step that touches Supabase,
DNS, Cloudflare or Maya. You prepare, check outputs, interpret stop conditions and fix repo code.

---

## 1. Read these first, in this order

1. `AGENTS.md` (repo rules: Supabase boundary, commits, RLS rules, gotchas). `CLAUDE.md` just includes it.
2. **This file.**
3. `docs/decisions/2026-10-26-release-night-runbook.md`: **the step-by-step plan you will follow.**
   The dates in it say 26 Oct; that night did not happen. The steps are still correct.
4. `docs/decisions/2026-09-20-accounts-orders-release.md`: design of the orders feature (why, data model).
5. `docs/decisions/2026-09-20-dns-move-checklist.md`: DNS record inventory + move + checks + undo.
6. `docs/decisions/2026-09-20-hosting-and-previews.md`: why Cloudflare Pages, how previews/env work.
7. `.agents/BOARD.md`: handoffs from earlier sessions (the 2026-09-20 orders-backend entry and the
   2026-10-26 prep entry are the relevant ones).

## 2. Where everything is

| Thing | Location |
|---|---|
| Release worktree (work here) | `~/Projects/barkhaus-hosting`, branch `release/accounts-orders` (head `a8fb75b` on 27 Oct, pushed) |
| Main checkout | `~/Projects/barkhaus` on `main`. **Has someone else's uncommitted edits** (`docs/technical-doc.html`, `supabase/migrations/20260801090000_pet_vaccine_document_types.sql`). Don't touch, commit or revert them. It also has untracked `vercel.json` / `.vercelignore` from an abandoned Vercel plan: obsolete, Gelo may delete. Its local `main` is behind origin; that's fine. |
| Release PR | https://github.com/geloavendano/barkhausph/pull/77 (open, mergeable). **Merge only at runbook step D.** |
| Rollback tag | `pre-orders` = `1dd0569` = current `origin/main` (site + functions as live today). Pushed to GitHub. |
| Production Supabase | project ref `dxttnbtfhpanyiyduevn` (`https://dxttnbtfhpanyiyduevn.supabase.co`). Anon key is public, in `env.js`. |
| Staging Supabase | a Supabase preview branch, switched on/off by Gelo: `~/Projects/claude-setup/staging/staging.sh up\|down\|snapshot\|previews barkhaus` |
| Cloudflare Pages | project `barkhausph`. Production build of `main`: https://barkhausph.pages.dev. Branch preview: https://release-accounts-orders.barkhausph.pages.dev (uses **staging** DB; needs staging up to load data). Build: `sh scripts/build-site.sh` → `dist/` (allowlist copy). |
| Current live host | GitHub Pages (`server: GitHub.com`), DNS at dotPH (`dns1/dns2.domains.ph`) |
| Backup script | `scripts/backup-production.sh` → writes `~/Backups/barkhaus/<timestamp>-pre-release/` (does not exist yet: never run) |
| Pre-flight SQL | `scripts/preflight-production.sql` (read-only; the backup script runs it) |
| Payment regression check | `node scripts/payment-flow-regression-check.mjs` |
| Monitoring | Better Stack (primary) for `payment-health` / `maya-health`; GitHub Actions `payment-health.yml` hourly backup canary |
| Test console | `~/Projects/barkhaus-dev/barkhaus-tests.html` |

## 3. Decisions already made by Gelo (don't reopen these)

- Hosting: **Cloudflare Pages**, not Vercel (decided 2026-09-20).
- **DNS move and feature release on the same night, DNS first** (decided 2026-10-26). Keep them as two
  separately verified steps.
- **Every hosted checkout is an order.** The existing `create-maya-checkout` accepts both today's
  single-booking body and `{ items: [...] }`. No new checkout endpoint. Bookings stay individual in admin
  (calendar, lists), tagged with `bookings.order_id`, and share one Maya payment ID.
- **Order ref = first booking's generated ref** (`generate_ref_number()` trigger, unchanged). No `-A/-B`
  suffixes (the trigger would overwrite them).
- **One combined confirmation email** per order.
- Test the order path with **one real payment + refund** on barkhaus.ph, carts hidden from customers
  until it passes.
- Backups: **local pg_dump (via the script) + confirm the Supabase dashboard daily backup.**

## 4. Re-verify state before doing anything

Run from `~/Projects/barkhaus-hosting`. Expected results as of 27 Oct are in comments. If any differ,
something happened since. Find out what before following the runbook.

```bash
git fetch -q origin && git status -sb | head -2          # on release/accounts-orders, in sync with origin
git log --oneline -1 origin/release/accounts-orders      # a8fb75b (or newer commits by Gelo/you)
git log --oneline -1 origin/main                         # 1dd0569 (= pre-orders). Anything else: main moved; re-check the PR diff
gh pr view 77 --json state,mergeable                     # OPEN, MERGEABLE
curl -sI https://barkhaus.ph/ | grep -i '^server'        # GitHub.com  (Cloudflare after the DNS move)
dig +short barkhaus.ph NS                                # dns1/dns2.domains.ph (Cloudflare NS after step A)
K=$(grep -oE "supabaseAnonKey: '[^']+'" env.js | sed -E "s/.*'([^']+)'/\1/")
curl -s "https://dxttnbtfhpanyiyduevn.supabase.co/rest/v1/booking_orders?select=id&limit=0" \
  -H "apikey: $K" -H "Authorization: Bearer $K"          # PGRST205 "Could not find the table" = backend NOT deployed
                                                         # 42501 "permission denied" = table EXISTS (migration applied)
ls ~/Backups/barkhaus 2>/dev/null                        # empty/missing = backup never run
node scripts/payment-flow-regression-check.mjs           # "passed"
```

Ask Gelo what, if anything, was done since 27 Oct (daytime prep items in the runbook especially).

## 5. What's on the release branch (vs `main`)

- **Frontend:** the new booking experience moved from `/staging/` to the root (`index.html`,
  `booking.html` + `booking.js`, `account/`, `app.js`, `customer-account.js`). `_redirects` 308s old
  `/staging/*` links. The staging folder is removed. Cart checkout posts `{items:[...]}` once to
  `create-maya-checkout`.
- **`MULTI_SERVICE_ENABLED = false`** in `booking.js` (added 26 Oct): hides "Add another service or pet".
  `?orders=on` turns it on for that browser tab (sessionStorage `barkhaus_orders_tester`), `?orders=off`
  turns it off. Never shown in walk-in mode.
- **Cancel fix** in `booking.js` (26 Oct): the abandon-checkout call to `cancel-pending-booking` now sends
  `Authorization: Bearer <anon>`. Production runs that function with JWT verification on, so the live
  site's call gets 401 today and the held slot stays blocked until the expiry job. Verified by probe:
  without the header the gateway says `UNAUTHORIZED_NO_AUTH_HEADER`; with it the function answers 400
  "ref_number and cancellation_token are required" (= reached the function).
- **Backend** (functions, deployed by Gelo): `create-maya-checkout` (items, one fee on the first booking,
  locks across items, `MAX_ORDER_ITEMS` env, default 5), `handle-payment-webhook` (`finalizePending()`
  extracted; order path; duplicate check per (payment ID, booking); one combined email),
  `reconcile-maya-bookings` (groups by order; never looks a booking up in Maya by its own ref),
  `get-payment-status` (order-aware; `orderStatusFromChildren`), `cancel-pending-booking` (cancels a
  whole order), `customer-account` (CORS for Cloudflare origins).
  Staging-only: `simulate-payment`, `staging-signin`. Both 404 on production by project-ID check.
  **Never deploy them to production.**
- **Migrations** (applied on staging only):
  `20260920130000_booking_orders.sql` (new table + nullable `bookings.order_id`,
  `pending_bookings.order_ref`; RLS via `is_admin()`), and
  `20260920140000_payments_reference_unique_per_booking.sql` (drops the table-wide unique on
  `payments.reference_number` **by name**, adds unique `(reference_number, booking_id)`).
- Staging-tool pages `simulate-payment.html` and `email-preview.html` ship in `dist/`. Both are `noindex`
  and switch themselves off when `BH_ENV.name !== 'staging'`. Accepted.

Tested: on staging with the simulator on 2026-09-20 (2-item order priced with one fee, both confirmed,
own payment rows, duplicate event no-op, expiry cancels whole order). **Not tested:** the release preview
with the 26 Oct changes against staging (staging was off), and nothing at all against production.

## 6. Verified facts about production (26–27 Oct, by read-only probes)

| Fact | How it was checked |
|---|---|
| No orders schema (`booking_orders` missing; `bookings.order_id`, `pending_bookings.order_ref` missing) | PostgREST errors PGRST205 / 42703 with the anon key |
| `public.is_admin()` exists (orders migration's RLS needs it) | `POST /rest/v1/rpc/is_admin` → `false` |
| RLS hides customer tables from anon | `Prefer: count=exact` on bookings/owners/pets/payments/pending_bookings → `*/0` |
| `simulate-payment` not deployed | 404 |
| JWT gates: **webhook + reconcile = `--no-verify-jwt`**; get-payment-status, cancel-pending-booking, create-maya-checkout, customer-account = **verification on** | Empty unauthenticated requests: gateway error `UNAUTHORIZED_NO_AUTH_HEADER` = verify on; function's own JSON error = verify off. Webhook from `docs/maya-checkout-setup.md`. Not probed, to avoid triggering alert emails. |
| No `supabase/config.toml` → CLI deploy **defaults to verify on** | `ls supabase` |
| No Supabase project linked locally | `supabase/.temp/project-ref` absent → every command must pass `--project-ref` |
| Mac has no `pg_dump`/`psql`/Docker; Supabase CLI v2.90.0 (works; update optional) | `which`, `supabase --version` |
| `/usr/bin/env bash` is **bash 3.2** | `bash --version` |

Not verified (only Gelo can see): Supabase plan / whether today's daily backup exists / PITR; current
Auth redirect URL list; whether deployed functions match git (the backup script checks this); the
production `payments` unique-constraint name (pre-flight §1 checks this); Better Stack monitors.

## 7. Your job, step by step

Follow `docs/decisions/2026-10-26-release-night-runbook.md`. Summary with what **you** do at each step:

**Daytime prep (no customer impact).** Walk Gelo through runbook "Daytime prep" 1–6:
`brew install libpq`, `supabase login`; dashboard backup check; add Auth redirect URLs
`https://barkhaus.ph/account/` and `https://www.barkhaus.ph/account/`; Cloudflare DNS checklist steps
1–4 (add zone, import, compare all 12 records, **DKIM values end to end**, add Pages custom domains);
Better Stack website monitor; and the **release preview test on staging** (not yet done). For that
test, Gelo runs `staging.sh up barkhaus`, you check the preview: no "Add another" by default, appears
with `?orders=on`, simulator 2-item order → both confirmed + one email (email viewer link on the
confirmation screen), abandon → holds released.

**0. Backup.** Gelo runs, in one terminal that stays open all night:
```bash
cd ~/Projects/barkhaus-hosting
read -rs BH_PROD_DB_URL && export BH_PROD_DB_URL   # Supabase → Connect → Session pooler URI, password filled in
bash scripts/backup-production.sh
```
You read the output. **Go only if all are true:**
- Last line is "Backup complete. Deployed functions match git." If it says some differ: stop. Ask Gelo
  to show the diff (`diff <(git show pre-orders:supabase/functions/<fn>/index.ts) ~/Backups/barkhaus/<run>/live-functions/supabase/functions/<fn>/index.ts`),
  port any dashboard-only change into the branch, commit, then continue.
- Pre-flight §1 shows the table-wide unique as `payments_reference_number_unique` **or**
  `payments_reference_number_key`. Another name means you must edit migration
  `20260920140000_...` to drop that exact name (commit + push), then re-run pre-flight.
- §2 returns 0 rows; §3 empty (or wait ≤15 min); §4 `t, t, f`.
- If "NOT COMPLETE": fix the failing part first (typical: libpq not on PATH, `supabase login` missing,
  wrong URI). The script refuses URIs that don't contain the production ref.

**A. DNS move.** Checklist step 5 (nameservers at dotPH → Cloudflare's two; keep dotPH records as the undo).
Then continue with B while it spreads; run the checklist's "After the move" checks once Cloudflare says Active.

**B. Backend.** Exact commands are in the runbook. Order matters (readers before the writer):
migrations (two `psql -1 -v ON_ERROR_STOP=1 -f` runs) → `supabase secrets set MAX_ORDER_ITEMS=1` →
deploy `handle-payment-webhook --no-verify-jwt`, `reconcile-maya-bookings --no-verify-jwt`,
`get-payment-status`, `cancel-pending-booking`, `customer-account`, **`create-maya-checkout` last**,
all with `--project-ref dxttnbtfhpanyiyduevn`, **from `~/Projects/barkhaus-hosting`** (main doesn't
have the order code). Then the runbook's 3-query check. **Gate B:** one real single booking on the live
site → 1-item `paid` row in `booking_orders`, booking confirmed + paid, one payment row, one email.
Fail → rollback "Functions".

**C.** Prefer DNS Active + checked before D. If it's still spreading after about an hour, D can proceed
(both hosts build `main`); rollback then uses `git revert`.

**D. Frontend.** Gelo merges PR #77. Wait for Cloudflare's production build (check
`curl -s https://barkhausph.pages.dev/booking.js | grep -c MULTI_SERVICE_ENABLED` ≥ 1). Smoke test per
the runbook (including back out of Maya → slot released, `/account/` sign-in with Google + email code,
saved pet prefill, `/staging/booking` → 308 `/booking`, `/admin`). Gate D: one more real single booking.

**E. 2-item test.** `MAX_ORDER_ITEMS=5`; Gelo uses `https://barkhaus.ph/booking?orders=on`. Expect one
Maya payment for the combined total, both bookings confirmed + paid, **two** payment rows sharing one
Maya payment ID, **one** combined email, `booking_orders.item_count = 2`. Refund in Maya, cancel both in
admin. Abandon test. Reconcile dry run (`x-reconcile-token` header). Pass → (now or later) set
`MULTI_SERVICE_ENABLED = true` in `booking.js`, commit to `main`. Fail → `MAX_ORDER_ITEMS=1`.

**F. Watch** Better Stack + `payment_events` for a few hours; recheck mail/DNS next morning.

## 8. Rollback (also in the runbook)

| Problem | Action |
|---|---|
| Carts misbehave | `supabase secrets set MAX_ORDER_ITEMS=1 --project-ref dxttnbtfhpanyiyduevn` (seconds). Customers can't see carts anyway while the flag is off. |
| New pages broken | Cloudflare → Deployments → previous production → Rollback **and** `git revert -m 1 <merge sha>` pushed to `main` (covers GitHub Pages visitors during DNS spread) |
| Single-booking checkout regresses | `git worktree add ../barkhaus-pre-orders pre-orders`, then redeploy the six functions **from there with the same JWT flags**. New columns are nullable and go unused. |
| DNS / mail broken | dotPH → restore `dns1.domains.ph` / `dns2.domains.ph` |
| Data damaged (last resort, ask Gelo) | `pg_restore --data-only -t <table>` from `db-public.dump`, or the dashboard backup. A full restore loses newer bookings. |

The migrations only add things. Don't write down-migrations unless asked. After a 2-booking order exists,
the old table-wide unique can't be restored, which is expected.

## 9. Traps (each one cost time or was a near miss)

1. **JWT flags.** CLI deploy defaults to verify **on**. Webhook or reconcile deployed without
   `--no-verify-jwt` = Maya/cron get 401 = paid bookings stay pending, then risk expiry. Don't change
   flags on the other four either.
2. **Deploy from the release worktree**, not `~/Projects/barkhaus` (main): main doesn't have the order code.
3. **Always `--project-ref`.** No project is linked; without it the CLI may prompt or hit the wrong project.
4. **`supabase functions download` writes into `./supabase/functions/<fn>` of the working directory**
   and would overwrite repo files. The backup script uses `--workdir` into the backup folder. Keep it that way.
5. **The unique-constraint name** (pre-flight §1). The migration drops by guessed name; a survivor silently
   drops the second booking's payment row (happened on staging).
6. **bash 3.2:** `${arr[*]}` on an empty array under `set -u` crashes. The script uses a string for
   failures. Keep new script code 3.2-safe, and run it with `bash`, not `sh`.
7. **`scripts/build-site.sh` rewrites `env-staging.js` locally.** Always `git checkout -- env-staging.js`
   after a local build. It must stay the empty placeholder (a `main` build with staging settings fails on purpose).
8. **Both switches gate carts:** frontend `MULTI_SERVICE_ENABLED` (button) and server `MAX_ORDER_ITEMS`.
   With `MAX_ORDER_ITEMS=5` and the flag off, only `?orders=on` testers can make carts.
9. **Rollback during DNS spread:** Cloudflare Rollback alone doesn't cover visitors still on GitHub Pages.
10. **Never deploy `simulate-payment` / `staging-signin` to production.** Never point a preview or localhost
    at production (`env.js` refuses; don't "fix" that).
11. **Customer data stays out of the repo.** Backups go to `~/Backups/...` only. Don't commit, upload
    or paste dump contents.
12. **RLS:** admin policies use `public.is_admin()`. Never `TO authenticated USING (true)` (AGENTS.md).
13. **Pronouns:** use they/them for Gelo. (An old memory note says "him"; it's not stated by Gelo.)
14. **Git stash is shared across worktrees/sessions.** Don't use bare `git stash`.
15. Maya is in **production** mode for all functions. Every test payment is real money. Use the cheapest
    services, refund in the Maya dashboard, then cancel in admin.

## 10. Don't

- Merge PR #77 before Gate B passes.
- Run anything that writes to production yourself (migrations, deploys, secrets, dashboard). Gelo does.
  Read-only probes with the public anon key are fine.
- Edit or commit the other teammate's uncommitted files in `~/Projects/barkhaus`.
- Change prices, the admin calendar, or the payment provider (out of scope).
- Fix the SPF record during the DNS move (copy it unchanged; fix separately later).

## 11. After a successful release (follow-ups)

- [ ] `MULTI_SERVICE_ENABLED = true` once the 2-item test passes (commit to `main`).
- [ ] `AGENTS.md` → "Deployment model" and "Commands": production is Cloudflare Pages; remove "GitHub
      Pages today". Update `.agents/BOARD.md` (clear Active/Claimed, add a handoff with what ran).
- [ ] `docs/technical-doc.html` §12: add the cancel-header incident and the orders gotchas (shared Maya
      payment ID per order; reconcile must look up the order ref; JWT flags per function).
- [ ] `docs/test-scenarios.md`: order scenarios (1-item, 2-item, abandon, duplicate webhook, expiry).
- [ ] Two weeks after the DNS move: disable GitHub Pages, delete `CNAME`, consider making the repo
      private (hosting decision), fix SPF (`+ip4: ` space; `+a`).
- [ ] Admin drawer "Order · N bookings" label (optional; planned, not built).
- [ ] Open question still pending: whether `docs/` should stay public.
- [ ] Delete obsolete `vercel.json` / `.vercelignore` in `~/Projects/barkhaus` (ask Gelo).
