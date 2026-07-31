# Barkhaus Agent Board

Use this board for lightweight coordination between Codex, Claude Code, and human
teammates. Keep entries short and current.

## Active

- None.

## Claimed Files

- None.

## Handoffs

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
