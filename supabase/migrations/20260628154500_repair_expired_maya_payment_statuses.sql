-- These bookings were cancelled by the retired timeout job but incorrectly
-- retained payment_status = paid despite having no payment record or successful
-- Maya event. Keep the repair narrowly scoped to the audited references.

UPDATE public.bookings AS b
SET payment_status = 'unpaid'
WHERE b.ref_number IN (
    'BH-2A1ADF',
    'BH-07BF12',
    'BH-C7B5FB',
    'BH-792AF5',
    'BH-F8326F'
  )
  AND b.status = 'cancelled'
  AND b.payment_status = 'paid'
  AND b.cancellation_reason = 'Payment timeout (15 min)'
  AND NOT EXISTS (
    SELECT 1
    FROM public.payments AS p
    WHERE p.booking_id = b.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_events AS pe
    WHERE pe.ref_number = b.ref_number
      AND pe.payment_status IN ('PAYMENT_SUCCESS', 'SUCCESS')
  );
