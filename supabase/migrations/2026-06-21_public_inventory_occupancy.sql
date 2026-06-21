-- Expose only the inventory fields needed by the public booking flow. These
-- SECURITY DEFINER functions avoid granting anonymous users access to booking
-- rows or customer data while still respecting cancelled/rejected statuses.

CREATE OR REPLACE FUNCTION public.get_grooming_occupancy(
  p_branch_id uuid,
  p_service_date date
)
RETURNS TABLE (
  booking_id uuid,
  groomer_id uuid,
  timeslot text,
  groom_service_key text,
  has_duration_addon boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    gd.booking_id,
    gd.groomer_id,
    gd.timeslot::text,
    gd.groom_service_key::text,
    EXISTS (
      SELECT 1
      FROM public.booking_addons ba
      WHERE ba.booking_id = gd.booking_id
        AND ba.addon_key IN ('demat', 'deshed')
    ) AS has_duration_addon
  FROM public.grooming_details gd
  JOIN public.bookings b ON b.id = gd.booking_id
  WHERE b.branch_id = p_branch_id
    AND gd.service_date = p_service_date
    AND b.status NOT IN ('cancelled', 'rejected');
$$;

CREATE OR REPLACE FUNCTION public.get_hotel_occupancy(
  p_branch_id uuid,
  p_checkin date,
  p_checkout date
)
RETURNS TABLE (
  room_id uuid,
  room_type text,
  checkin_date date,
  checkout_date date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    hd.room_id,
    hd.room_type::text,
    hd.checkin_date,
    hd.checkout_date
  FROM public.hotel_details hd
  JOIN public.bookings b ON b.id = hd.booking_id
  WHERE b.branch_id = p_branch_id
    AND hd.checkin_date < p_checkout
    AND hd.checkout_date > p_checkin
    AND b.status NOT IN ('cancelled', 'rejected');
$$;

REVOKE ALL ON FUNCTION public.get_grooming_occupancy(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_hotel_occupancy(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_grooming_occupancy(uuid, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_hotel_occupancy(uuid, date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
