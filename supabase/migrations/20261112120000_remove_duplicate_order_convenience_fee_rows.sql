-- One-off data repair (12 Nov 2026): remove the convenience-fee charge rows that the payment webhook
-- added to the 2nd, 3rd… booking of a multi-booking order.
--
-- What happened: an order charges ONE convenience fee, carried by its first booking (BH-XXXXXX-A).
-- The amounts charged were always right. But create-maya-checkout stored each cart item's payload as
-- the browser sent it, with the fee on every item, and the webhook itemises booking_charges from that
-- payload. So every later booking got a "Convenience fee" line its total doesn't include, and the
-- admin drawer and printout showed the fee once per booking. Fixed going forward in
-- create-maya-checkout (payload now carries the server's amounts); deploy that BEFORE running this.
--
-- On 12 Nov this matched 18 rows on 17 orders (₱360 of display-only lines). Charges, payments,
-- booking totals and order amounts are not touched.
-- Undo: re-insert (booking_id, type 'convenience_fee', label 'Convenience fee', amount, sort_order)
-- for the refs the preview lists.
-- No DDL, so no schema reload needed.

-- 1. Preview: expect only -B/-C refs, each with the order's fee (₱20).
SELECT b.ref_number, c.amount, o.convenience_fee AS order_fee
FROM booking_charges c
JOIN bookings b       ON b.id = c.booking_id
JOIN booking_orders o ON o.id = b.order_id
WHERE c.type = 'convenience_fee'
  AND o.item_count > 1
  AND b.ref_number <> o.order_ref || '-A'
ORDER BY b.ref_number;

-- 2. Delete them (run after the preview looks right).
DELETE FROM booking_charges c
USING bookings b, booking_orders o
WHERE c.booking_id = b.id
  AND o.id = b.order_id
  AND c.type = 'convenience_fee'
  AND o.item_count > 1
  AND b.ref_number <> o.order_ref || '-A'
RETURNING b.ref_number, c.amount;
