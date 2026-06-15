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

## Supabase Manual Queue

Record any edge function deploys, table/schema changes, RLS policy changes, or schema-cache
reloads the human needs to apply manually.

- Apply `supabase/migrations/2026-06-16_payment_receipt_live_setup.sql` to add
  `payments.receipt_path`, ensure the private `vaccine-docs` bucket exists, and reload
  PostgREST schema.
- Deploy `submit-booking` after the migration so online manual-transfer bookings write
  confirmed/paid bookings and required receipt payment rows.
- Deploy `get-upload-url` if the Supabase project is ever recreated; the live endpoint
  responded successfully on 2026-06-16, but the source file is being committed for drift
  prevention.

## Done

- 2026-06-16 - Codex: added idempotent receipt setup migration, committed
  `get-upload-url` source, and changed `submit-booking` to fail/rollback if a manual
  payment receipt row cannot be recorded.
- 2026-06-16 - Codex: added shared agent collaboration setup (`AGENTS.md`, `CLAUDE.md`,
  `.agents/BOARD.md`).
