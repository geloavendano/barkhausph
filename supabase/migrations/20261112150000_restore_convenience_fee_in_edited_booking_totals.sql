-- One-off data repair (12 Nov 2026): put the online convenience fee back into bookings.total for
-- bookings whose total lost it when an admin edited them.
--
-- What happened: the admin "Edit booking" panel (AddBookingPanel save, edit branch) PATCHed
-- bookings.total = calcTotal().total, which is service pricing only (subtotal - discount). It kept the
-- booking's 'convenience_fee' charge row but dropped the fee from the total. So the total fell ₱20
-- below what the customer paid (payments.amount, and booking_orders.amount for orders).
-- Fixed going forward in admin-src (the edit adds the kept fee row back to the total); publish that
-- admin build BEFORE running this, or new edits will keep breaking totals.
--
-- Which bookings: the fee charge row exists, the total equals subtotal - discount (fee missing), and
-- the booking has an admin full edit (booking_edits.field_changes.admin_edit = true). For an order
-- only the first booking carries the fee (order_ref-A, or the only booking).
-- On 12 Nov (read-only check) this matched 770 bookings: 86 order bookings + 684 pre-order online
-- bookings. 1 more booking has the fee row and a net total but no admin full edit; it is left
-- alone (cause unknown) and listed by query 1b.
--
-- Only bookings.total changes (the updated_at trigger also bumps updated_at). Charges, payments,
-- payment_status and order amounts are not touched. Nothing reads bookings.total to compute an
-- outstanding balance in admin; get-payment-status / reconcile-maya-bookings compare it to the Maya
-- amount for unpaid bookings and expect the fee-inclusive total.
-- Undo: UPDATE bookings SET total = total - <fee> for the refs the RETURNING list prints.
-- No DDL, so no schema reload needed.

-- 1a. Preview (summary): expect fee 20 throughout and ~770 rows. On 12 Nov (read-only dry run):
--     order bookings: 85 "paid = total + fee", 1 "paid < total"; pre-order: 654 "paid = total + fee",
--     23 "paid < total", 7 "other" (more paid than total + fee). 770 rows, ₱15,400 restored.
--     "paid = total + fee" means the customer paid the fee, so after the repair paid = total.
WITH fee AS (
  SELECT booking_id, sum(amount) AS fee
  FROM booking_charges WHERE type = 'convenience_fee' GROUP BY booking_id
), edited AS (
  SELECT DISTINCT booking_id FROM booking_edits
  WHERE coalesce(
          CASE WHEN jsonb_typeof(field_changes) = 'string' THEN (field_changes #>> '{}')::jsonb
               ELSE field_changes END ->> 'admin_edit', '') = 'true'
), target AS (
  SELECT b.id, b.ref_number, b.order_id, b.payment_status, b.total, fee.fee,
         (SELECT coalesce(sum(CASE WHEN p.type = 'refund' THEN -p.amount ELSE p.amount END), 0)
            FROM payments p WHERE p.booking_id = b.id) AS paid
  FROM bookings b
  JOIN fee    ON fee.booking_id = b.id
  JOIN edited ON edited.booking_id = b.id
  LEFT JOIN booking_orders o ON o.id = b.order_id
  WHERE b.booking_source = 'online'
    AND b.total = b.subtotal - coalesce(b.discount_amount, 0)
    AND (o.id IS NULL OR o.item_count = 1 OR b.ref_number = o.order_ref || '-A')
)
SELECT (order_id IS NOT NULL) AS in_order, payment_status, fee,
       CASE WHEN paid = total + fee THEN 'paid = total + fee'
            WHEN paid < total       THEN 'paid < total (price raised after payment)'
            WHEN paid = total       THEN 'paid = total'
            ELSE 'other' END AS paid_vs_total,
       count(*) AS bookings, sum(fee) AS fee_restored
FROM target GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 4;

-- 1b. Fee row + net total but NO admin full edit: not repaired here, look at these by hand.
SELECT b.ref_number, b.payment_status, b.total, b.subtotal, b.discount_amount
FROM bookings b
JOIN booking_charges c ON c.booking_id = b.id AND c.type = 'convenience_fee'
WHERE b.total = b.subtotal - coalesce(b.discount_amount, 0)
  AND NOT EXISTS (
    SELECT 1 FROM booking_edits e WHERE e.booking_id = b.id
      AND coalesce(CASE WHEN jsonb_typeof(e.field_changes) = 'string'
                        THEN (e.field_changes #>> '{}')::jsonb ELSE e.field_changes END ->> 'admin_edit', '') = 'true');

-- 2. Repair (run after the preview looks right). Same filter as 1a.
BEGIN;

WITH fee AS (
  SELECT booking_id, sum(amount) AS fee
  FROM booking_charges WHERE type = 'convenience_fee' GROUP BY booking_id
), edited AS (
  SELECT DISTINCT booking_id FROM booking_edits
  WHERE coalesce(
          CASE WHEN jsonb_typeof(field_changes) = 'string' THEN (field_changes #>> '{}')::jsonb
               ELSE field_changes END ->> 'admin_edit', '') = 'true'
)
UPDATE bookings b
SET total = b.total + fee.fee
FROM fee
JOIN edited ON edited.booking_id = fee.booking_id
WHERE fee.booking_id = b.id
  AND b.booking_source = 'online'
  AND b.total = b.subtotal - coalesce(b.discount_amount, 0)
  AND (b.order_id IS NULL OR EXISTS (
        SELECT 1 FROM booking_orders o WHERE o.id = b.order_id
          AND (o.item_count = 1 OR b.ref_number = o.order_ref || '-A')))
RETURNING b.ref_number, fee.fee;

-- 3. Check before COMMIT: the order check below should show no paid order with ok = false,
--    except orders whose first booking's price was raised by an edit after payment (2 on 12 Nov).
WITH x AS (
  SELECT o.id, o.item_count, sum(b.total) = o.amount AS ok
  FROM booking_orders o JOIN bookings b ON b.order_id = o.id
  WHERE o.status = 'paid' GROUP BY o.id
)
SELECT item_count, ok, count(*) FROM x GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;  -- or ROLLBACK if step 2/3 look wrong
