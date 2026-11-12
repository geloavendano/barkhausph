-- One-off data review (12 Nov 2026): payments the admin "Edit booking" panel recorded for money that
-- was already recorded.
--
-- What happened: when staff saved an edit with Payment status Paid/Partially paid and a payment method
-- picked, AddBookingPanel inserted a 'balance' payment for the booking's FULL total, even when the
-- booking was already fully paid. Fixed going forward in admin-src: an edit now records only the part of
-- the total not already recorded (nothing if fully paid). Screens, fields and the create path are
-- unchanged. Publish that admin build before acting on this.
--
-- Read-only check on 12 Nov: 15 payments since June were inserted within seconds of an admin edit. All
-- but these were legitimate first recordings. The suspect rows are all from 17 Jun 2026 (the day the
-- admin audit fields shipped, so possibly test edits; confirm before deleting):
--   * 3 'balance' payments of ₱8,000 on 2 admin bookings that already had an ₱8,000 downpayment
--     (₱24,000 counted twice). Query 1 lists them; step 2 deletes them.
--   * 1 booking marked partially_paid with its full ₱1,200 recorded. Query 3 lists it with every other
--     partially_paid booking whose payments already cover the total (11 on 12 Nov; most are not from
--     the edit path). Nothing here changes them: only staff know what was actually received.
-- Undo for step 2: re-insert the rows the RETURNING prints (booking_id, amount, type, method, created_at).
-- No DDL, so no schema reload needed.

-- 1. Preview: edit-time 'balance' payments made when earlier payments already covered the total.
WITH full_edit AS (
  SELECT booking_id, edited_at FROM booking_edits
  WHERE coalesce(CASE WHEN jsonb_typeof(field_changes) = 'string' THEN (field_changes #>> '{}')::jsonb
                      ELSE field_changes END ->> 'admin_edit', '') = 'true'
), suspect AS (
  SELECT DISTINCT p.id
  FROM payments p
  JOIN bookings b    ON b.id = p.booking_id
  JOIN full_edit e   ON e.booking_id = p.booking_id
                    AND p.created_at BETWEEN e.edited_at - interval '10 seconds' AND e.edited_at + interval '10 seconds'
  WHERE p.type = 'balance'
    AND (SELECT coalesce(sum(CASE WHEN q.type = 'refund' THEN -q.amount ELSE q.amount END), 0)
           FROM payments q
          WHERE q.booking_id = p.booking_id AND q.created_at < p.created_at) >= b.total
)
SELECT b.ref_number, b.booking_source, b.payment_status, b.total, p.amount, p.method, p.created_at
FROM suspect s JOIN payments p ON p.id = s.id JOIN bookings b ON b.id = p.booking_id
ORDER BY b.ref_number, p.created_at;

-- 2. Delete them (only once the preview shows the expected 3 rows and you've confirmed they were
--    never real money). Same filter as 1.
BEGIN;

WITH full_edit AS (
  SELECT booking_id, edited_at FROM booking_edits
  WHERE coalesce(CASE WHEN jsonb_typeof(field_changes) = 'string' THEN (field_changes #>> '{}')::jsonb
                      ELSE field_changes END ->> 'admin_edit', '') = 'true'
), suspect AS (
  SELECT DISTINCT p.id
  FROM payments p
  JOIN bookings b    ON b.id = p.booking_id
  JOIN full_edit e   ON e.booking_id = p.booking_id
                    AND p.created_at BETWEEN e.edited_at - interval '10 seconds' AND e.edited_at + interval '10 seconds'
  WHERE p.type = 'balance'
    AND (SELECT coalesce(sum(CASE WHEN q.type = 'refund' THEN -q.amount ELSE q.amount END), 0)
           FROM payments q
          WHERE q.booking_id = p.booking_id AND q.created_at < p.created_at) >= b.total
)
DELETE FROM payments p USING suspect s
WHERE p.id = s.id
RETURNING p.booking_id, p.amount, p.type, p.method, p.created_at;

COMMIT;  -- or ROLLBACK if the RETURNING list is not the 3 expected rows

-- 3. For review only: partially_paid bookings whose recorded payments already equal or exceed the total.
SELECT b.ref_number, b.total,
       (SELECT coalesce(sum(CASE WHEN p.type = 'refund' THEN -p.amount ELSE p.amount END), 0)
          FROM payments p WHERE p.booking_id = b.id) AS paid
FROM bookings b
WHERE b.payment_status = 'partially_paid'
  AND (SELECT coalesce(sum(CASE WHEN p.type = 'refund' THEN -p.amount ELSE p.amount END), 0)
         FROM payments p WHERE p.booking_id = b.id) >= b.total;
