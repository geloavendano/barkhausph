# Barkhaus Agent Board

Use this board for lightweight coordination between Codex, Claude Code, and human
teammates. Keep entries short and current.

## Active

- None.

## Claimed Files

- None.

## Handoffs

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

- None.

## Done

- 2026-06-16 - Human/Codex: manual-payment receipt setup is verified live. Supabase
  `payments.receipt_path` exists, `payments.method = 'manual_online'` is allowed,
  `submit-booking` was redeployed, and payment details now appear in the admin drawer.
- 2026-06-16 - Codex: added idempotent receipt setup migration, committed
  `get-upload-url` source, and changed `submit-booking` to fail/rollback if a manual
  payment receipt row cannot be recorded.
- 2026-06-16 - Codex: added shared agent collaboration setup (`AGENTS.md`, `CLAUDE.md`,
  `.agents/BOARD.md`).
