-- Migration: move the SERVICE date out of bookings.booking_date into each
-- service detail table's own `service_date` column (mirrors hotel_details'
-- checkin_date/checkout_date). After this, bookings.booking_date means the
-- date the booking was CREATED, consistent across every service.
--
-- RUN ORDER (see runbook):
--   1. Run STEP 1 + STEP 2 here (additive + backfill) — safe with old code running.
--   2. Deploy the new edge functions (create-payment, submit-booking, handle-payment-webhook).
--   3. Deploy the new admin build.
--   4. Run STEP 3 (repurpose booking_date) — cleanup, after the new code is live.

-- ── STEP 1: add the columns (additive, safe) ────────────────────────────────
ALTER TABLE grooming_details ADD COLUMN IF NOT EXISTS service_date date;
ALTER TABLE daycare_details  ADD COLUMN IF NOT EXISTS service_date date;
ALTER TABLE studio_details   ADD COLUMN IF NOT EXISTS service_date date;

-- ── STEP 2: backfill service_date from the old booking_date ──────────────────
-- (For grooming/daycare/studio, booking_date currently holds the service date.)
UPDATE grooming_details g
   SET service_date = b.booking_date
  FROM bookings b
 WHERE g.booking_id = b.id AND g.service_date IS NULL;

UPDATE daycare_details d
   SET service_date = b.booking_date
  FROM bookings b
 WHERE d.booking_id = b.id AND d.service_date IS NULL;

UPDATE studio_details s
   SET service_date = b.booking_date
  FROM bookings b
 WHERE s.booking_id = b.id AND s.service_date IS NULL;

-- ── STEP 3: repurpose booking_date as the CREATION date ──────────────────────
-- Run AFTER deploying the new edge functions + admin build. This rewrites the
-- column meaning for existing rows so it matches new rows going forward.
-- (Hotel rows already had booking_date null or a check-in date; setting them to
-- created_at::date is correct under the new "creation date" meaning.)
UPDATE bookings SET booking_date = created_at::date;
