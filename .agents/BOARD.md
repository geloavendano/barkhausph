# Barkhaus Agent Board

Use this board for lightweight coordination between Codex, Claude Code, and human
teammates. Keep entries short and current.

## Active

- 2026-10-27 - RELEASED: accounts + orders + cart are live on barkhaus.ph, served by Cloudflare
  Pages (PRs #77, #78, #79). Open follow-ups (watch first multi-item orders, MAX_ORDER_ITEMS code
  default, allowlist cleanup, docs) are listed in the Outcome section at the top of
  `.agents/HANDOFF-release-return.md`. Nothing is claimed.

## Claimed Files

- None. The release worktree `../barkhaus-hosting` has no uncommitted work besides `supabase/.temp/`.

## Release checkpoint (history: pre-release notes; see the Outcome in HANDOFF-release-return.md)

- FRONTEND RETURN FIX READY, BROWSER RETEST PENDING: expired cart BH-782B7E did release both
  holds, but returned to a permanent checking screen. Cart checkout saved only order_result,
  not bk_snapshot used by retry/edit. Local booking.js now saves both, renders combined unpaid
  return details, refreshes child/order refs and cancellation token on retry, and restores current
  item declarations on edit. New order-return-regression-check passes, as do payment regression,
  JS syntax and diff check. Need release preview rebuild and browser return/retry/edit retest.
  Checkout mutex fix committed as 03f4bf9; Gelo already deployed it to staging, no production deploy.
- STAGING BACKEND CHECKS PASSED; frontend return blocker found afterward. Gelo deployed checkout
  version 22 (verify_jwt=true). BH-2AEB79:
  2 confirmed/paid children, total 2420 = 1200 + 1200 + one 20 fee; two payment allocations
  1220/1200 share one SIM payment ID; one combined email contains both pets and total; zero holds.
  Repeated simulator success left two payment rows and one email. BH-782B7E: two holds observed
  before simulated PAYMENT_EXPIRED, then both cancelled/unpaid, zero holds/payment rows.
  No real payment/email; synthetic fixtures only. Single-item edit/cancel already passed.
  Gelo explicitly confirmed keeping -A/-B child references; corrected handoff/design docs.
  Next: confirm Better Stack website/payment monitors and full dotPH inventory, refresh recovery
  export/preflight before NS switch. Production still unchanged except previously applied view RLS.
- STAGING BLOCKER / LOCAL FIX READY: release preview passed hidden-by-default cart flag,
  `?orders=on`, 2 hotel items + one fee (PHP 2420), and single-order cancel/edit released holds
  (fixture order BH-26E614). Two-item submit failed because the second item reacquired this
  order's own branch-wide hotel mutex with a new token. Local checkout now acquires each key
  once but checks availability/blocks for every item. New executable regression reproduces
  failure on old source and passes fixed source: shared keys, duplicate inventory, blocked room,
  competing checkout, distinct keys, one release per key, RPC errors. Payment regression and
  diff check pass. Human next: deploy ONLY create-maya-checkout to staging ref
  jsvqukuiegdrojmdbqgi, JWT verification on; no DDL/schema reload needed. Retry preserved
  2-item cart, simulator payment, DB allocations and one combined email before any DNS move.
  Neither new source nor tests are committed/pushed yet; no production deploy/merge/NS switch.
- RESOLVED GUIDE/CODE DISCREPANCY (Gelo confirmed keep -A/-B on 27 Oct): handoff said no lettered refs, but
  committed release code (43eab27) renames multi-item booking refs to order-A/order-B.
  Staging trigger is BEFORE INSERT only, so it does not overwrite subsequent UPDATEs.
  Mutex fix leaves reference behavior untouched. Handoff/design now reflect Gelo's confirmed choice.
- Staging already exists; Gelo's `up barkhaus` stopped before changes. Reuse it; do NOT run down.
  Parent branch inventory confirms staging ref jsvqukuiegdrojmdbqgi is ACTIVE_HEALTHY; its historical
  branch status is MIGRATIONS_FAILED (snapshot-built schema exists). Direct read-only SQL confirms
  orders + staging email outbox present, 2 branches and 58 pricing rows. Earlier get_project 404
  did not mean it was deleted; branch metadata is obtained via the parent's branches endpoint.
  Opened release-accounts-orders preview booking page; both branch choices load. Runtime test
  of default flag, 2-item simulator checkout/email, and abandon flow is in progress.
- Gelo reached the existing zone's activation Overview; screenshot confirms assigned NS
  donald.ns.cloudflare.com / harlee.ns.cloudflare.com. "Begin DNS transfer" in Pages opens
  generic onboarding; use existing Domains -> barkhaus.ph -> Overview instead.
  Next requested user action remains `~/Projects/claude-setup/staging/staging.sh up barkhaus`
  for the outstanding release-preview test. Do not change registrar NS before remaining prep.
- CLOUDFLARE ORDER CORRECTION: Pages apex setup shows "Transfer DNS management" / "Begin DNS
  transfer" because the existing zone is not active yet. This is the intended DNS move, not a
  registrar transfer. Current Pages docs require active Cloudflare nameservers before the apex
  custom domain can finish. Complete other prep first; activate DNS with imported GitHub records
  intact, then finish Pages apex/www setup and verify both hosts before backend/frontend release.
  Pages custom domains have NOT been attached yet. Do not claim DNS cutover readiness until full
  dotPH inventory confirmation, monitors and release-preview staging tests are complete.
- DNS EXPORT VERIFIED: all 16 imported A/CNAME/MX/TXT record values exactly match current
  dotPH authoritative DNS (TXT chunks concatenated for comparison), including both entire DKIM
  values, SPF, DMARC, Google verification, send MX/SPF and staging CNAME. mail/webmail confirmed
  `cf-proxied:false`. TTL 1 in Cloudflare export denotes automatic. Saved export outside git at
  `/Users/gelo/Backups/barkhaus/20261027-cloudflare-zone-before-move.txt`.
  Assigned Cloudflare NS in export: donald.ns.cloudflare.com and harlee.ns.cloudflare.com.
  Not switched. Next: Pages project barkhausph custom domains for apex and www; still need full
  dotPH panel inventory confirmation, monitors, staging release-preview tests before NS change.
- Cloudflare zone added on Free plan; screenshot shows 6 A, 2 CNAME (including staging),
  2 MX, 6 TXT records. Gelo switched mail/webmail A records to DNS only; reported TTL "1"
  (unit not independently verified). MX/TXT were already DNS only. Need full zone export to
  compare TXT/DKIM end-to-end and confirm staging CNAME target against dotPH. Nameservers
  must remain unchanged until record verification, Pages custom domains, and other prep pass.
- Gelo confirmed both root account Auth redirect URLs were added and saved (existing entries kept).
  Cloudflare DNS preparation is next. pages.dev serves 200 with a browser User-Agent (the default
  Python User-Agent was rejected). Production root and /booking serve today's site; production
  env-staging.js is empty. Release preview has the multi-service switch; the older staging branch
  does not. Both previews point at staging ref jsvqukuiegdrojmdbqgi; runtime tests still pending.
  Current known authoritative DNS records saved outside git at
  `/Users/gelo/Backups/barkhaus/20261027-dns-before-move.txt`; still need full dotPH panel export.
- VIEW FIX APPLIED BY GELO AND VERIFIED: `security_invoker=true` is live. Anonymous API HEAD
  returns 0 rows; read-only ordinary authenticated-role simulation returns 0; read-only admin-role
  simulation returns all 57 expected rows (matches privileged baseline). Only counts were read.
  This resolves the view security release blocker. Next human step: add/confirm the two root
  account Auth redirect URLs, preserving existing entries. Staging/Cloudflare prep still pending.
- VERIFIED fallback export: `/Users/gelo/Backups/barkhaus/20261027-024128-dcf9f3f2-table-recovery`,
  02:41:28–02:41:56 PHT on 27 Oct. All 78 inventory tables have exports; verifier passed all
  80 data/metadata files and SHA256SUMS, folder 0700 and files private. Counts: bookings 3946,
  payments 1667, owners 2476, pets 2833, Auth users/identities 14 each, Storage objects 760.
  Preflight passed: zero active checkouts, zero duplicate payment groups, expected named unique,
  is_admin=true, ref trigger=true, orders absent. This passes the user-requested fallback gate,
  not a full pg_dump/restore-test gate. Original Git bundle and backup checksums verified too.
  Latest remote check: main/tag still 1dd0569, PR #77 OPEN/MERGEABLE, site GitHub Pages/dotPH.
  NEXT HUMAN STEP: apply the prepared view security SQL in production SQL Editor, then agent
  verifies anonymous denial and Gelo checks admin access. Auth redirects, Cloudflare DNS prep,
  monitoring, and release-preview staging tests remain unconfirmed; no nameserver switch/merge yet.
- Reviewed customer-account discrepancy is an older known Git version, not dashboard-only code
  requiring a merge. Keep the release's birthdate handling. Rollback instructions must use the
  actual downloaded account function, with the tag for the other five release functions.
- Gelo requested daily backup + fresh table exports as a fallback to failing DB-password dumps.
  Prepared `scripts/export-production-data.py`: password-free Management API, READ ONLY SQL,
  CLI login from Keychain (same approach as staging.sh); exports all public/auth/storage base-table
  rows outside git, per-table timestamps/counts, preflight, inventory, checksums and local verifier.
  Synthetic checks passed for successful export, corruption, interruption, and truncated/missing
  rows. NOT run against production yet; Gelo must run it. This is a supplementary recovery copy,
  not a standalone pg_dump or one consistent cross-table snapshot; daily restore + manual
  reconciliation is required. Alternative gate and limitations added to release runbook §0.
- Supabase MCP connected for read-only diagnostics. Production is ACTIVE_HEALTHY on
  Postgres 17.6.1.104. `postgres` can log in, has no expiry. Orders absent; migration prerequisites
  present; payments constraint is exactly `payments_reference_number_unique`.
  Pooler logs show repeated session-mode authentication failures through 2026-10-27 02:22 PHT;
  these do NOT establish the root cause or confirm the new password is correct.
  SECURITY RELEASE BLOCKER: `public.bookings_needs_action` has default view security, no
  admin predicate, grants to anon/authenticated. Anonymous HEAD returned 206 with a nonzero
  count (no rows retrieved). Draft a human-applied `security_invoker=true` migration and verify
  anon/ordinary signed-in users cannot read rows while admin access still works. Not applied.
  Draft ready: `supabase/migrations/20261026182733_secure_bookings_needs_action_view.sql`;
  it includes `NOTIFY pgrst, 'reload schema';`. Added to backend runbook after backup gate.
  Live source-table policies were reviewed; SQL has NOT been applied or behavior-tested.
  Read-only advisor baseline also includes existing performance/security warnings; no unrelated
  fixes were made. Pooler evidence: "SecretChecker not started, using a one-off auth_query
  connection" followed by "ClientHandler: Exchange error: password authentication failed".
- Direct `psql` attempt failed at DNS resolution before authentication. Checked public DNS:
  direct hostname has an AAAA record, no A record; local system resolver cannot resolve it,
  while the shared-pooler hostname resolves to IPv4. This direct test does not validate
  the reset password. Next: one bounded pooler retry after confirming its hostname/user
  against production Connect settings; do not loop backup attempts or reset again.
- Gelo reset the database password, then the explicit shared-pooler `psql -W` test still
  failed authentication. Backup gate remains closed. Next: confirm reset was on production
  project `dxttnbtfhpanyiyduevn`, then Gelo tests direct `db.dxttnbtfhpanyiyduevn.supabase.co`
  with username `postgres` to distinguish database credentials from post-reset pooler caching.
  No additional reset, restart, schema change, or deployment has been requested.
- Backup attempt `/Users/gelo/Backups/barkhaus/20261027-0212-pre-release` is NOT COMPLETE:
  PostgreSQL password authentication failed; public/auth/storage dumps are zero bytes and
  pre-flight did not run. Git bundle and deployed function downloads succeeded.
  `customer-account` differs from `pre-orders` but exactly matches Git commit `d14b296`:
  deployed source predates pet birthdate handling; no dashboard-only code was found in this diff.
  STOP before deployments until this discrepancy is reflected in the rollback instructions:
  restoring that function from `pre-orders` would NOT restore the currently deployed source.
  Its actual rollback source is saved under this backup folder's
  `live-functions/supabase/functions/customer-account/index.ts`.
  Next connection check: Gelo runs a read-only `psql -W` SELECT 1 with the pooler hostname
  and `postgres.dxttnbtfhpanyiyduevn` username, entering the raw database password separately.
- Gelo confirmed PITR is disabled and the latest dashboard daily backup is
  `2026-10-25 20:15:00 UTC` (`2026-10-26 04:15:00 PHT`). Fresh local backup remains required.
- 2026-10-27 - Codex: local backup script now reports NOT COMPLETE on function-download
  or checksum failure. Bash 3.2 syntax and isolated checks for matching source, differing source,
  download failure, and checksum failure pass; no live Supabase CLI calls were run.
  Next: Gelo logs into Supabase, confirms the dashboard backup/PITR status, then runs the
  backup script with the production Session pooler URI entered hidden in their terminal.
  Database backup, deployed-function comparison, and production pre-flight are still pending.

## Handoffs

- 2026-10-27 - Claude Code: release executed with Gelo. PR #77 merged early, rolled forward (backend
  deployed 19:13 PHT), Gate B passed on real booking BH-25691C (webhook-recorded), Pages custom domains
  + www→apex redirect live, `MAX_ORDER_ITEMS=20`, cart ON (#79, real-money 2-item test skipped by
  Gelo's choice), "A different pet" chip (#78). Details and open items: Outcome section of
  `.agents/HANDOFF-release-return.md`.
- 2026-10-26 - Claude Code: release-night prep (branch release/accounts-orders, nothing merged or
  deployed). Verified: production has none of the orders changes; site still on GitHub Pages;
  Cloudflare Pages serving; `pre-orders` = origin/main 1dd0569. Added `MULTI_SERVICE_ENABLED` (off;
  testers use `?orders=on`), fixed the cancel-pending-booking call (missing Authorization header:
  production gateway answered 401, so abandoned holds stayed until expiry), `scripts/backup-production.sh`
  + `scripts/preflight-production.sql`, and `docs/decisions/2026-10-26-release-night-runbook.md`.
  Live JWT gates checked by probing: webhook + reconcile need `--no-verify-jwt`, the rest default.
  HUMAN TODO: follow the runbook top to bottom; backup must end "Backup complete" before any change.
- 2026-09-20 - Claude Code: orders backend (branch release/accounts-orders). One hosted checkout can
  now cover several bookings: booking_orders + bookings.order_id + pending_bookings.order_ref;
  create-maya-checkout accepts `{items:[...]}` (one fee, one Maya session, locks held across items);
  the webhook resolves the order, finalizes each booking with the shared finalizePending() and sends
  ONE email; reconcile groups by order (never looks an order's booking up by its own ref);
  get-payment-status and cancel-pending-booking are order-aware. Staging-only: simulate-payment
  (paid/failed/expired) drives the real webhook, emails go to staging_email_outbox, and checkout
  returns the simulator URL instead of Maya. Both are gated by the production project id, not a flag.
  Tested on the staging branch only (applied + deployed there): 2-item order priced with one fee,
  both bookings confirmed with their own payment rows, duplicate event a no-op, expired cancels the
  whole order. HUMAN TODO for production, in this order:
    1. `git tag pre-orders <sha of main before this release>` already created; push it if you want it on GitHub.
    2. Apply `supabase/migrations/20260920130000_booking_orders.sql`, then
       `supabase/migrations/20260920140000_payments_reference_unique_per_booking.sql` (both additive;
       the second replaces the table-wide unique on payments.reference_number with unique per booking).
    3. Set `MAX_ORDER_ITEMS=1` on the project (refuses carts server-side until you are ready).
    4. Deploy in this order: handle-payment-webhook, reconcile-maya-bookings, get-payment-status,
       cancel-pending-booking, customer-account, then create-maya-checkout LAST.
       Do NOT deploy simulate-payment to production (it answers 404 there anyway).
    5. Gate: make one real single-booking checkout on the live site. Expect a 1-item order, a
       confirmed+paid booking, one payments row and today's email. Then raise MAX_ORDER_ITEMS when
       the frontend ships.
  No PostgREST reload beyond the `notify pgrst` inside each migration.
- 2026-09-20 - Claude Code: hosting/env-config. Every page (public site, `/staging/`
  pages, admin) now reads Supabase settings from `env.js` (production on barkhaus.ph /
  barkhausph.pages.dev, staging everywhere else, refuses without settings). Cloudflare
  Pages project `barkhausph` builds `dist/` from an allowlist (`scripts/build-site.sh`);
  previews use staging via Preview variables that `staging.sh up` keeps current. Added
  `_headers`, `404.html`; payment-health backup canary is now hourly. AGENTS.md has a new
  Environments section. HUMAN TODO: merge to `main`, then test the production build at
  https://barkhausph.pages.dev (booking page loads real branches; nothing internal is
  published), then follow docs/decisions/2026-09-20-dns-move-checklist.md. No Supabase
  deploys or DDL are needed for this change.
- 2026-09-17 - Codex: hotel room `blocked_schedules` now remove the room from
  production/staging public availability and Admin Add Booking for every occupied
  night (check-in inclusive, checkout exclusive). The public pre-payment recheck and
  all booking Edge Function paths independently reject blocked rooms. Admin assets
  were rebuilt and the scenario matrix records the rule. HUMAN TODO: deploy
  `submit-booking`, `create-maya-checkout`, and `create-payment` with default JWT
  verification, then publish the static commit. No DDL or PostgREST schema reload is
  needed. Verify the existing Estancia Small Cage 3 block makes a Sep 21–22 stay show
  Unavailable, while a Sep 20–21 stay remains unaffected. Unit tests, public/staging
  syntax checks, Admin production build, live PostgREST overlap query, and Edge
  Function bundles pass. Hotel-block validation is self-contained inside each of the
  three changed Edge Function `index.ts` files, so dashboard deployments do not depend
  on adding or updating a `_shared` module. Full Admin lint remains blocked by 43
  pre-existing errors outside this change; targeted availability lint passes.
- 2026-08-01 - Codex: account pet setup now captures required birth year/month
  plus optional day, while `customer-account` validates the partial date in PHT
  and derives the existing age fields used by booking/admin. Review now has one
  top order summary, collapsible child details, a single Total, and a direct
  “Proceed to payment” handoff; the temporary “Everything looks ready” screen
  and generic planning note are gone. Staging still blocks payment writes and
  explains that checkout is not enabled. HUMAN TODO: apply
  `supabase/migrations/20260801113000_pet_birthdate_parts.sql` (it also safely
  repairs a missing `pet_vaccine_documents.vaccine_key` and runs the PostgREST
  schema-cache NOTIFY), then deploy `customer-account` with default JWT
  verification. Apply SQL before the function deploy. Node syntax checks, Edge
  Function bundling, one-/two-item order review behavior, collapsible details,
  staging payment handoff, and 390px birthdate/review layouts pass.
- 2026-08-01 - Codex: refined the staged customer account and multi-booking
  flow. OTP is full-width and has a 60-second resend cooldown; pet age/unit are
  grouped; landing account actions use a contained dropdown; every vaccine has
  its own keyed upload; saved pets can be selected before size/service choices;
  the size-change toast is gone; and combined review retains every child detail
  card while one shared calculation reconciles allocations, the single
  order-level fee, total, and sticky footer. HUMAN TODO: apply
  `supabase/migrations/20260801090000_pet_vaccine_document_types.sql` (it adds
  `pet_vaccine_documents.vaccine_key` and runs the schema-cache NOTIFY), then
  deploy `customer-account` with default JWT verification. Apply the migration
  before deploying the function because its profile query selects the new
  column. Syntax checks, Edge Function bundling, responsive layout measurements,
  and one-/two-child mobile review checks pass; the static commit should be
  pushed only after the Supabase steps succeed.
- 2026-07-31 - Codex: corrected the staged customer-account flow after live
  setup testing. Email OTP now accepts the configured 6-10 digit code instead
  of assuming six; account fields use border-box sizing and a narrower shell;
  provider choices/sign-in copy are explicitly hidden after auth; each current
  vaccine has its own required, non-expired date stored in the existing
  `pet_profile_vaccines.valid_until`; and add/edit pet validates membership
  code, activity, expiry, and pet name in the UI and again in
  `customer-account` before saving. The booking preview shows the saved date per
  vaccine. HUMAN TODO: deploy the updated `customer-account` function with
  default JWT verification after the existing customer-account migration is
  present. No new DDL or schema reload is needed. Static JS checks, Edge Function
  bundling, local layout measurements, 8-digit entry, vaccine-date enablement,
  hidden setup choices, and membership success feedback pass.
- 2026-07-31 - Codex: added the dashboard-ready Supabase customer Auth email at
  `supabase/templates/customer-auth-otp.html`, visually adapted from the current
  booking confirmation. It includes both `{{ .Token }}` for six-digit entry and
  `{{ .ConfirmationURL }}` as the fallback sign-in link. HUMAN TODO: in hosted
  Supabase, set the Magic Link template subject to `Your Barkhaus sign-in code`,
  replace its body with this file, and send an OTP to a test inbox after Resend
  SMTP is configured. No Edge Function deploy, DDL, or schema reload is needed.
- 2026-07-31 - Codex: implemented real staging customer accounts in the repo:
  Google SSO + email OTP with a customer-only Auth storage key, persistent
  operational owner/pet profiles, per-pet vaccine declarations, and reusable
  private vaccine-document uploads through a new authenticated
  `customer-account` Edge Function. Customer and admin authorization remain
  independent; customer logout uses local scope so it does not revoke a separate
  admin session. HUMAN TODO: apply
  `supabase/migrations/20260731223000_customer_accounts.sql` (it already runs
  `NOTIFY pgrst, 'reload schema';`), deploy with
  `supabase functions deploy customer-account` using default JWT verification,
  add `https://barkhaus.ph/staging/account/` to Supabase Auth redirect URLs, and
  update the Magic Link email template to display `{{ .Token }}` for six-digit
  OTP entry (keep `{{ .ConfirmationURL }}` as a fallback link). Google and email
  providers are already enabled. Verify new/returning Google, OTP, account CRUD,
  document upload, and same-email admin/customer session isolation afterward.
- 2026-07-31 - Codex: moved staging account registration out of the landing
  modal and into `/staging/account/`. The landing choice now separates existing
  account sign-in, guest booking, and account creation; unmatched sign-ins route
  to the standalone page instead of expanding the modal. The dedicated page
  reuses the complete owner + pet profile setup and still returns to `/staging/`
  signed in after creation. This creates a stable URL for future post-booking or
  campaign prompts. No Supabase action is needed.
- 2026-07-31 - Codex: rewrote staging-only visible copy in customer language,
  removing references to Admin, production/frontend mechanics, write guards, and
  technical preview behavior. The landing account greeting is now positioned at
  the top of the page (not fixed), uses plain underlined text, and reveals Manage
  account + Log out only when clicked. The booking header now says My account rather
  than repeating a sticky Hi-name control. No Supabase action is needed.
- 2026-07-31 - Codex: expanded the staging customer account into a two-step
  owner + full pet-profile setup and reused the same full form for add/edit pet.
  Profiles now cover species, sex, size, breed, age, temperament, medical/care
  notes, vaccines, record validity, local-only document filenames, membership,
  vet, and emergency contacts. Account creation redirects to `/staging/` signed
  in; it no longer starts a booking. Selecting a saved pet populates compatible
  booking, vaccine, document, membership, care, vet, and emergency fields. This
  remains browser-local mock data; no Supabase action or schema reload is needed.
- 2026-07-31 - Codex: replaced the standalone staging prototype with copies of the
  actual Barkhaus landing page and full booking wizard. The staging-only insertions
  are customer-account entry/profile and pet selection, same-branch add-another
  booking, combined `BH-3CE089-A/B` review/allocation, and email-confirmation preview.
  A browser-level request guard permits production GETs and only the occupancy/member
  read RPCs; it blocks every Edge Function, Storage, and data-write request. No
  Supabase deploy, DDL, RLS, webhook, email, or schema-cache reload is needed.
- 2026-07-31 - Codex: added the production-domain read-only redesign preview at
  `/staging/` and `/staging/booking/`. It reads live production branches, pricing,
  resources, Grooming/Hotel occupancy, and membership validation, but has no Auth,
  Storage, booking, payment, webhook, or email write paths. Full pet/owner fields,
  vaccine and peg file selection (browser-local only), hotel care/emergency fields,
  waivers, multi-service Review, order references, allocations, and email summary are
  represented. No Supabase deploy, DDL, or schema-cache reload is needed.
- 2026-07-31 - Codex: published a private frontend-only booking redesign prototype
  at `https://barkhaus-booking-staging.geloavendano.chatgpt.site`. It demonstrates
  guest/Google/OTP entry, saved pet profiles, availability-first selection, same-branch
  multi-service cart, `BH-XXXXXX-A/B` child references, one mock Maya payment with child
  allocations, account pet management, and a combined confirmation email. Source lives
  in `/Users/gelo/Projects/barkhaus-booking-staging`; production Barkhaus, Supabase,
  Maya, Edge Functions, customer data, uploads, and email were not touched.
- 2026-07-15 - Codex: stopped destructive upload cleanup in `get-upload-url` so
  booking attachments in the `vaccine-docs` bucket are not auto-deleted just because
  their upload authorization expired. Added browser-side compression for JPEG/PNG/WEBP
  vaccine records, grooming pegs, and manual receipts before upload; PDFs and HEIC/HEIF
  intentionally remain untouched. HUMAN TODO: push/static publish for `booking.js`, then
  manually deploy `supabase functions deploy get-upload-url`. No DDL and no PostgREST
  schema reload needed.
- 2026-07-09 - Claude: booking-info consistency audit + fixes. Root issue: online
  bookings only got most child records from the full webhook, so recovered ones were
  incomplete and online grooming pegs were dropped entirely; walk-ins had no
  booking_charges. Fixes: (#1/#2) create-maya-checkout now persists pet_vaccines,
  vaccine_documents, waivers, grooming_reference_images up front + webhook inserts made
  idempotent (dd509bb); (#3) submit-booking builds booking_charges for public/walk-in
  flows, gated by skipServerCharges which AddBookingPanel now sets to avoid duplicating
  its own client-side charges (9416da5). HUMAN TODO: deploy create-maya-checkout,
  handle-payment-webhook, submit-booking. Deferred: #4 webhook doesn't create *_details
  (edge case, fallback path only); #5 merge the two buildEmailHtml — they intentionally
  differ by payment state (pay-in-store notice vs already-paid), so not a mechanical
  extract; do shared-helpers-only or a parameterized merge with per-path email testing.
- 2026-07-09 - Claude: reconcile-with-Maya-before-cancel. New edge function
  `reconcile-maya-bookings` (token-gated via RECONCILE_TOKEN, deploy --no-verify-jwt):
  for each expiring pending Maya hold it checks Maya first — finalizes paid ones via the
  webhook, cancels only when Maya is reachable and shows no matching success, and skips
  when Maya is unreachable (never cancels a maybe-paid booking). Phase 2 recovers
  already-cancelled unpaid online bookings Maya says are paid (mirrors get-payment-status
  recovery); `?sweep=1&days=N&dry=1` runs the historical victim backfill as a preview.
  Migration `2026-07-09_reconcile_before_cancel_cron.sql` repoints the cron to
  net.http_post this function (needs pg_net + RECONCILE_TOKEN placeholder swapped);
  expire_pending_bookings() kept as manual backstop. HUMAN TODO: set RECONCILE_TOKEN env,
  deploy the function --no-verify-jwt, apply the migration with the real token, then run a
  dry sweep. Root case: BH-E0D9B8 (QRPH paid, webhook never delivered, cron cancelled it).
- 2026-07-08 - Codex: fixed walk-in bookings being created as online when
  `PAYMENT_GATEWAY_PROVIDER` is a hosted provider such as Maya. Walk-in submits now
  always route to `submit-booking`, so the edge function can validate the one-time
  token and store `booking_source = walkin`. Verified production `submit-booking`
  recognizes invalid walk-in tokens before inserts; `node --check booking.js` passes.
- 2026-07-07 - Codex: replaced admin-guide mock/stale screenshots with current UI
  captures. Desktop captures are now 1920px wide; mobile captures are 430px wide and
  constrained in the guide so they do not stretch/pixelate. Drawer/payment/note shots
  were cropped to avoid public contact/receipt details. `28-walkin-summary.png` now
  uses the current Walk-in FAB entry point rather than a fake final summary; replace it
  from a safe non-production walk-in flow when one is available. Validation: diff check,
  image-reference check, dimensions, and PNG signatures pass.
- 2026-07-07 - Codex: refreshed the admin guide to v0.3 against the current live
  admin. Updated Pending navigation, five-minute fallback refresh, drawer/history,
  membership CSV/type rules, pencil-booked status, runtime pricing language, and Maya
  payment-status checks. Added privacy-reviewed live captures for login, desktop
  Calendar/branch state, mobile More, groomer schedules, collapsed Pending queues,
  Groomer Reports, and Payment Status Check. Remaining dashed screenshots are annotated
  references awaiting safe live replacements.
- 2026-07-04 - Codex: added the public GA4 customer funnel (`booking_start`,
  `booking_form_complete`, `begin_checkout`, `purchase`). Purchase fires only after
  successful manual submission or confirmed hosted payment, uses the booking reference
  for deduplication, excludes walk-ins/PII, and carries PHP value, branch, and service.
  JavaScript syntax, diff checks, and local page loading pass. GA4 still needs `purchase`
  marked as a key event and a Funnel exploration configured in the property.
- 2026-06-19 - Codex: date-specific groomer hours are implemented across public/admin
  slot selection and submit rechecks. Static code safely retains legacy hours only while
  the new table is absent. Authenticated drawer visual QA remains after the migration is
  applied; production build, public/gate smoke checks, and 11 helper tests pass.
- 2026-06-16 - Codex: live checks showed `barkhaus.ph/booking.js` and the admin
  bundle already include manual-payment receipt code, and `get-upload-url` can create a
  signed upload URL. Live PostgREST still reports `payments.receipt_path` missing, so the
  receipt cannot be stored/read by the admin drawer until the migration below is applied.
- 2026-06-16 - Codex: changed manual-upload payment rows to store
  `method = 'manual_online'` and the selected destination bank (`GCash`, `BPI`, or `BDO`)
  in `payments.notes`. Admin drawer now labels `manual_online` as "Manual online" and
  shows payment notes under the payment metadata.
- 2026-06-16 - Codex: customer test exposed the live `payments_method_check`
  constraint rejecting `manual_online`. Added a migration to expand the allowed payment
  methods and made booking error recovery restore the summary markup before rebuilding it.
- 2026-06-16 - Codex: customer retest exposed `payments_type_check` rejecting
  `online_transfer`. Changed manual-upload payment rows to use the existing allowed
  `type = 'downpayment'` while keeping `method = 'manual_online'` and destination bank in
  `payments.notes`.

## Supabase Manual Queue

Record any edge function deploys, table/schema changes, RLS policy changes, or schema-cache
reloads the human needs to apply manually.

- Deploy the hotel block enforcement functions with default JWT verification:
  `supabase functions deploy submit-booking --project-ref dxttnbtfhpanyiyduevn`,
  `supabase functions deploy create-maya-checkout --project-ref dxttnbtfhpanyiyduevn`,
  and `supabase functions deploy create-payment --project-ref dxttnbtfhpanyiyduevn`.
  No DDL or PostgREST schema-cache reload is needed. After deployment, verify a direct
  request selecting a room blocked on any occupied night is rejected before records or
  a hosted checkout are created.
- Apply `supabase/migrations/20260801090000_pet_vaccine_document_types.sql`.
  It adds the nullable, constrained/indexed `pet_vaccine_documents.vaccine_key`
  column and already runs `NOTIFY pgrst, 'reload schema';`. Existing documents
  remain valid as unclassified legacy records.
- After that migration succeeds, deploy the updated authenticated account API:
  `supabase functions deploy customer-account --project-ref dxttnbtfhpanyiyduevn`.
  Keep default JWT verification. Verify add/edit pet uploads one document under
  each vaccine type and a returning account receives `vaccineKey` per document.
- Configure Resend as Supabase Auth custom SMTP, then set the hosted Magic Link
  email subject to `Your Barkhaus sign-in code` and paste
  `supabase/templates/customer-auth-otp.html` into the template body. Verify both
  six-digit entry and fallback-link sign-in at `/staging/account/`; no schema
  reload is needed.
- Deploy the updated authenticated account API with
  `supabase functions deploy customer-account --project-ref dxttnbtfhpanyiyduevn`.
  Keep default JWT verification. This activates server-side membership checks
  and per-vaccine validity persistence; no DDL or schema-cache reload is needed.
- Apply `supabase/migrations/2026-06-19_resource_service_hours.sql` to production. It
  creates/RLS-enables the table, seeds 90 days at 09:00-19:00 with a 17:00 cutoff,
  converts matching legacy weekday blocks to explicit dates, retires legacy rows, and
  includes `NOTIFY pgrst, 'reload schema';`.
- After the migration succeeds, deploy the updated function with
  `supabase functions deploy submit-booking`. Verify a grooming submit outside service
  hours returns the availability error before creating any records.
- Apply `supabase/migrations/2026-06-20_resource_color_hex.sql` before saving one of
  the new resource colors. It replaces the legacy fixed palette checks with generic
  six-digit hex validation and reloads the PostgREST schema cache.
- Apply `supabase/migrations/2026-06-20_resource_sort_order.sql` to backfill NULL
  resource orders and automatically append resources inserted outside the admin UI.

## Done

- 2026-06-16 - Human/Codex: manual-payment receipt setup is verified live. Supabase
  `payments.receipt_path` exists, `payments.method = 'manual_online'` is allowed,
  `submit-booking` was redeployed, and payment details now appear in the admin drawer.
- 2026-06-16 - Codex: added idempotent receipt setup migration, committed
  `get-upload-url` source, and changed `submit-booking` to fail/rollback if a manual
  payment receipt row cannot be recorded.
- 2026-06-16 - Codex: added shared agent collaboration setup (`AGENTS.md`, `CLAUDE.md`,
  `.agents/BOARD.md`).
