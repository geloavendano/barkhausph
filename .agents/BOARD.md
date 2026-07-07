# Barkhaus Agent Board

Use this board for lightweight coordination between Codex, Claude Code, and human
teammates. Keep entries short and current.

## Active

- None.

## Claimed Files

- None.

## Handoffs

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
