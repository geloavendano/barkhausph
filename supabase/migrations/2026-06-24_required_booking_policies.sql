-- Explicit acceptance fields for mandatory booking policies.
-- Nullable preserves the distinction between historical rows that predate the
-- policies and new rows where acceptance is recorded.
ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS house_rules_accepted boolean,
  ADD COLUMN IF NOT EXISTS grooming_booking_policy boolean,
  ADD COLUMN IF NOT EXISTS hotel_cancellation_policy boolean;

COMMENT ON COLUMN public.waivers.house_rules_accepted IS
  'Mandatory General House Rules acceptance. Null means the booking predates this policy.';
COMMENT ON COLUMN public.waivers.grooming_booking_policy IS
  'Mandatory Grooming Services Booking Policy acceptance for grooming bookings. Null means not applicable or not historically recorded.';
COMMENT ON COLUMN public.waivers.hotel_cancellation_policy IS
  'Mandatory Hotel Cancellation and Refund Policy acceptance for hotel bookings. Null means not applicable or not historically recorded.';

NOTIFY pgrst, 'reload schema';
