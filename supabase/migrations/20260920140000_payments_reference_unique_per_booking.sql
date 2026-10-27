-- One Maya payment can now cover several bookings (orders), and each booking records its own share.
-- Those rows share the provider's payment ID, so `payments.reference_number` can no longer be unique
-- on its own — it becomes unique per booking.
--
-- Backward-compatible: today every reference belongs to one booking, so the new rule accepts every
-- existing row. It still stops the real mistake it was added for: recording the same payment twice
-- against the same booking. Found by testing a 2-booking order on staging, where the second booking's
-- payment row was silently rejected.
-- Safe to re-run.

alter table public.payments drop constraint if exists payments_reference_number_unique;
alter table public.payments drop constraint if exists payments_reference_number_key;

create unique index if not exists payments_reference_number_booking_uidx
  on public.payments (reference_number, booking_id)
  where reference_number is not null;

comment on index public.payments_reference_number_booking_uidx is
  'A provider payment reference is unique per booking: an order pays for several bookings with one payment ID.';

notify pgrst, 'reload schema';
