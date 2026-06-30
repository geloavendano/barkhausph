-- Allow the new 'pencil-booked' booking status.
-- The admin app added "Pencil-booked" to the status dropdown (value: pencil-booked),
-- but the bookings_status_check constraint still only permitted the original set,
-- so saving it failed with 23514 (check constraint violation).
--
-- Recreate the constraint with the full allowed set including 'pencil-booked'.
-- Before applying, sanity-check no row has a status outside this set (the ADD
-- validates existing rows and will fail otherwise):
--   SELECT status, count(*) FROM public.bookings GROUP BY status ORDER BY status;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'pending',
    'pencil-booked',
    'confirmed',
    'checked_in',
    'completed',
    'cancelled',
    'rejected'
  ));
