# Release night runbook: DNS to Cloudflare + accounts & multi-service booking (Mon 26 Oct 2026)

Supersedes the schedule in `2026-09-20-accounts-orders-release.md` §5 (Sep 21–22 never ran). The design
in that record is unchanged. DNS steps come from `2026-09-20-dns-move-checklist.md`.

**State on 26 Oct (verified):** barkhaus.ph is still on GitHub Pages (DNS at dotPH). Cloudflare Pages is
set up and serving `barkhausph.pages.dev` + branch previews. Production Supabase has **none** of the
orders changes (no `booking_orders`, no `order_id` / `order_ref`). `is_admin()` exists. `pre-orders`
(= `origin/main` 1dd0569) is the rollback point for both site and functions. Release branch
`release/accounts-orders` builds and passes the payment regression check.

Every Supabase and DNS step below is run by Gelo. Commands use:

```bash
export PROD=dxttnbtfhpanyiyduevn
cd ~/Projects/barkhaus-hosting          # the release worktree; functions deploy FROM HERE
```

## Daytime prep (no customer impact)

1. [ ] `brew install libpq` (gives `pg_dump` / `psql`), `supabase login`.
2. [ ] Supabase dashboard → **Database → Backups**: today's daily backup is listed. Note whether
       point-in-time recovery is on.
3. [ ] Supabase → Auth → URL Configuration → Redirect URLs: add `https://barkhaus.ph/account/` and
       `https://www.barkhaus.ph/account/` (harmless before the release; customer sign-in returns there).
4. [ ] Cloudflare DNS checklist steps **1–4** (add site, import records, compare all 12 rows, add the Pages
       custom domains). Screenshot dotPH's full record list. Nothing changes for visitors until step 5.
       If Pages requires "Transfer DNS management" for the apex, defer custom-domain attachment
       until the zone is Active in A. Keep imported GitHub website records intact until then.
5. [ ] Better Stack: add the website monitor (`/` and `/booking` contain "Barkhaus").
6. [ ] Release preview on staging (`staging.sh up barkhaus`, open
       `https://release-accounts-orders.barkhausph.pages.dev`): Review has **no** "Add another" button;
       with `?orders=on` it appears; simulator 2-item order → both confirmed, one email.
       **Verified 27 Oct:** after Gelo deployed the shared-mutex checkout fix to staging (version 22,
       JWT verification on), BH-2AEB79 has two confirmed/paid children (-A/-B), PHP 2420 total,
       one PHP 20 fee, two payment rows sharing one simulator payment ID, zero remaining holds,
       and one combined email. Repeated simulated success adds no payments/emails. Two-item
       BH-782B7E expired via simulator: both cancelled/unpaid, zero holds/payments. Earlier
       single-item BH-26E614 was cancelled by Edit booking details, releasing its hold.
       These are staging fixtures; real Maya, production email and production release remain untested.
       **Frontend follow-up still pending:** the expired cart return stayed on Checking your payment
       because it lacked bk_snapshot. Local fix and executable return/retry/edit regression pass;
       rebuild the release preview and verify its browser return/retry/edit flow before DNS.
7. [ ] Merge the release PR **only when told in step D**. Until then nothing reaches `main`.

## Night, in order (quiet hour, late)

### 0. Backup (about 15 min). Stop if it doesn't say "Backup complete"

```bash
# Session pooler URI from Supabase → Connect, password filled in. Typed hidden, kept only in this
# terminal (not in history or on disk); steps 0 and B both use it.
read -rs BH_PROD_DB_URL && export BH_PROD_DB_URL
bash scripts/backup-production.sh
```

Read the output before going on:

- [ ] `live-vs-git.txt`: every function **same as git**. If one *differs*, someone edited it in the
      dashboard. Don't deploy over it until the difference is merged into the branch.
- [ ] Pre-flight §1: the table-wide unique rule is named `payments_reference_number_unique` **or**
      `payments_reference_number_key`. **Any other name: stop.** The migration drops it by name, and a
      survivor would silently reject the second booking's payment row (it happened on staging).
- [ ] §2 returns no rows. §3 (checkouts in flight) is empty, or wait for them to expire (15 min).
- [ ] §4: `is_admin_exists t`, `ref_trigger_exists t`, `booking_orders_already_exists f`.

#### Alternative requested by Gelo on 27 Oct: daily backup + current table recovery exports

If database-password authentication blocks `pg_dump`, use the existing dashboard daily backup
as the full restore baseline and supplement it with current table data:

```bash
python3 scripts/export-production-data.py
```

Gelo runs this read-only operation. It uses the Supabase CLI account login via macOS Keychain
(or `SUPABASE_ACCESS_TOKEN`), not the database password. It exports every base table in `public`,
`auth`, and `storage` to a new private `~/Backups/barkhaus/*-table-recovery/` folder. It prints
table names/counts only; customer records and account credentials must stay out of chat/git.

Gate for this alternative: the run ends **TABLE EXPORT COMPLETE**, all inventory tables have
files, local JSON/count/checksum verification passes, and `preflight.json` passes the same checks
above (no active checkouts, no duplicate payment groups, expected constraint and prerequisites).
Retain the successful Git bundle and deployed function sources from the earlier backup attempt;
the incomplete `pg_dump` files are still incomplete and must never be described as valid dumps.

Limits: this supplements the daily backup; it is not a standalone schema backup or one shared
database snapshot. Each table has its own read-only transaction and export timestamp. A restore
requires human-reviewed reconciliation in FK order, including updates/deletions and Auth records;
do not blindly append CSV rows or replay booking triggers. New writes after the exports are not
covered. Storage exports contain metadata, not uploaded file contents. No restore test has run.
Re-export near the actual release window and re-run the live pre-flight checks before acting.

### A. DNS move (starts the propagation clock; content is unchanged)

Both GitHub Pages and Cloudflare serve today's `main`, so visitors see the same site whichever host
answers.

1. [ ] DNS checklist step 5: dotPH → nameservers → Cloudflare's two. Leave dotPH's records in place.
2. [ ] Continue with B while waiting for Cloudflare to show **Active**, then run the checklist's
       "After the move" checks (site + padlock, mail in/out with SPF/DKIM/DMARC PASS, Search Console).
       **27 Oct ordering correction:** if Pages apex setup was blocked pending DNS transfer,
       finish Pages custom domains for apex/www after Active, verify site/certificates, and only
       then continue B. Imported GitHub website records preserve the old site during activation.

### B. Backend to production (functions FROM the release worktree)

**27 Oct prerequisite, discovered through read-only MCP diagnostics:** the legacy
`bookings_needs_action` view bypasses its source tables' RLS and is accessible anonymously.
After the backup gate passes, apply the view security migration below and verify anonymous
and ordinary customer requests return no rows while admin access works. No release until
this check passes. The migration includes the PostgREST schema-cache reload.

```bash
psql "$BH_PROD_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261026182733_secure_bookings_needs_action_view.sql
psql "$BH_PROD_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20260920130000_booking_orders.sql
psql "$BH_PROD_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20260920140000_payments_reference_unique_per_booking.sql
supabase secrets set MAX_ORDER_ITEMS=1 --project-ref $PROD

# Order matters: every reader of orders goes live before the one writer (create-maya-checkout).
# JWT flags match what production runs today (verified 26 Oct): Maya and the cron call the first two
# without a Supabase token. Getting this wrong makes paid bookings stay pending.
supabase functions deploy handle-payment-webhook  --project-ref $PROD --no-verify-jwt
supabase functions deploy reconcile-maya-bookings --project-ref $PROD --no-verify-jwt
supabase functions deploy get-payment-status      --project-ref $PROD
supabase functions deploy cancel-pending-booking  --project-ref $PROD
supabase functions deploy customer-account        --project-ref $PROD
supabase functions deploy create-maya-checkout    --project-ref $PROD
# Never deploy simulate-payment or staging-signin to production (they answer 404 there anyway).
```

Check (expect: new index present, old rule gone, `order_id` column present):

```bash
psql "$BH_PROD_DB_URL" -X -c "select indexname from pg_indexes where tablename='payments' and indexname='payments_reference_number_booking_uidx';" \
  -c "select conname from pg_constraint where conrelid='public.payments'::regclass and conname like 'payments_reference_number%';" \
  -c "select column_name from information_schema.columns where table_name='bookings' and column_name='order_id';"
```

**Gate B (must pass before D):** one **real single booking** on the live site (cheapest service, your
own email). Expect: Maya page → paid → confirmation page; admin shows it confirmed + paid with one
payment row; one email as today; `select order_ref, status, item_count from booking_orders order by
created_at desc limit 1;` shows a 1-item `paid` order. **Fails → rollback "Functions" below.**

### C. Wait for DNS to be Active and checked (A.2)

Don't stack the release on top of an unverified DNS move. If DNS is still spreading after about an hour,
release anyway: both hosts deploy `main`. Just use the git-revert rollback, which covers both hosts.

### D. Release the frontend

1. [ ] Merge the PR `release/accounts-orders` → `main`. Cloudflare builds `main` (about 1 min);
       GitHub Pages too.
2. [ ] Smoke test on barkhaus.ph (private window): landing, `/booking` full single-booking flow up to
       the Maya page (then return and choose Edit booking details: the hold must be released),
       `/account/` sign-in with Google and with an email code, saved pet pre-fills the booking,
       `/staging/booking` forwards to `/booking`, `/admin` signs in.
3. [ ] One more **real single booking** through the new booking page (Gate D).

### E. Turn on multi-service for the 2-item test only

```bash
supabase secrets set MAX_ORDER_ITEMS=5 --project-ref $PROD
```

Customers still can't build a cart (the button is hidden). You can, with `https://barkhaus.ph/booking?orders=on`.

- [ ] Real **2-item order** (two cheapest services, same branch). Expect: one Maya payment for the
      combined total; both bookings confirmed + paid in admin; **two** payment rows sharing one Maya
      payment ID; **one** combined email; `booking_orders.item_count = 2`.
- [ ] Refund in the Maya dashboard; cancel both bookings in admin.
- [ ] Abandon test: start a 2-item order, return from Maya and choose Edit booking details → both
      holds released (slots free again). Merely navigating back leaves the retryable hold in place;
      retry/edit explicitly cancels it, or it is released on expiry. Staging's Customer abandons it
      button simulates PAYMENT_EXPIRED and tests that separate expiry path.
- [ ] Reconcile dry run: nothing listed under `cancelled` for a paid booking.
      `curl -s "https://$PROD.supabase.co/functions/v1/reconcile-maya-bookings?dry=1" -H "x-reconcile-token: <RECONCILE_TOKEN>"`

**Passed:** set `var MULTI_SERVICE_ENABLED = true;` in `booking.js`, commit to `main` (can wait for
another day). **Failed:** `MAX_ORDER_ITEMS=1`. Accounts and single bookings stay live.

### F. Watch

Better Stack `payment-health` / `maya-health` stay green for the next few hours; `payment_events` shows
no new alerts. Recheck mail and DNS next morning.

## Rollback

| Problem | Do this | Time |
|---|---|---|
| Carts misbehave | `supabase secrets set MAX_ORDER_ITEMS=1 --project-ref $PROD` | seconds |
| New pages broken | Cloudflare → Pages → barkhausph → Deployments → previous production → **Rollback**, **and** `git revert -m 1 <merge sha>` pushed to `main` (covers visitors still reaching GitHub Pages, and makes it stick) | 1–2 min |
| Single-booking checkout regresses | Redeploy today's functions from the tag (same flags as B): `git worktree add ../barkhaus-pre-orders pre-orders && cd ../barkhaus-pre-orders`, then the six deploy lines. The new columns are nullable and simply go unused. | 5 min |
| DNS / mail broken | dotPH → put `dns1.domains.ph` / `dns2.domains.ph` back | hours to spread |
| Data damaged (last resort) | Restore single tables from `db-public.dump` (`pg_restore --data-only -t <table>`), or the dashboard backup. A full restore loses bookings made since the backup, so ask first. | — |

**27 Oct rollback correction:** the downloaded live `customer-account` is the older Git version
`d14b296`, not the version in `pre-orders`. Before deploying that function during rollback,
copy its actual saved source into the rollback worktree:

```bash
cp /Users/gelo/Backups/barkhaus/20261027-0212-pre-release/live-functions/supabase/functions/customer-account/index.ts \
  /Users/gelo/Projects/barkhaus-pre-orders/supabase/functions/customer-account/index.ts
```

The other five release functions matched `pre-orders`. Preserve this original backup folder.
If using the daily-backup/table-export fallback, the failed `db-public.dump` is unusable;
restore the dashboard baseline and manually reconcile the table exports as described in §0.

## Known and accepted

- `simulate-payment.html` and `email-preview.html` ship to production. Both are `noindex` and switch
  themselves off outside staging. They do nothing on barkhaus.ph.
- `docs/` is still public (open question in the hosting decision). No secrets in it; the Postman
  environment files have empty keys.
- Fixed in this release: the "back out of Maya" cancel call was missing its Authorization header, so
  production's gateway refused it (401) and the slot stayed held until the expiry job.

The migrations add things but never remove data. Undoing them isn't needed for any rollback above. Once
an order with two bookings exists, the old table-wide unique rule can no longer be restored, which is
expected.
