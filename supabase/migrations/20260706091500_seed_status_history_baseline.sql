-- Establish a clearly labelled starting point for bookings that existed before
-- status-history tracking was enabled. This is a snapshot, not a reconstruction
-- of earlier movements.

INSERT INTO public.booking_status_history (
  booking_id, from_status, to_status, changed_at,
  changed_by_role, change_source
)
SELECT
  b.id, NULL, b.status, now(),
  'migration', 'migration_snapshot'
FROM public.bookings b
WHERE NOT EXISTS (
  SELECT 1
  FROM public.booking_status_history h
  WHERE h.booking_id = b.id
);

INSERT INTO public.payment_status_history (
  booking_id, from_status, to_status, changed_at,
  changed_by_role, change_source
)
SELECT
  b.id, NULL, b.payment_status, now(),
  'migration', 'migration_snapshot'
FROM public.bookings b
WHERE NOT EXISTS (
  SELECT 1
  FROM public.payment_status_history h
  WHERE h.booking_id = b.id
);
