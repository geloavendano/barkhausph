-- Close legacy anonymous reads on customer booking data.
--
-- Public availability must use the narrow SECURITY DEFINER occupancy RPCs
-- below. The admin dashboard continues to access these tables as an
-- authenticated user whose email exists in admin_users. Edge Functions use the
-- service role and therefore continue to bypass RLS.

BEGIN;

DO $$
DECLARE
  target_table text;
  policy_row record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'bookings',
    'waivers',
    'hotel_details',
    'grooming_details',
    'daycare_details',
    'studio_details'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);

    -- Replace every historical policy. Permissive RLS policies are combined
    -- with OR, so leaving an old authenticated policy in place could bypass
    -- the admin allow-list below.
    FOR policy_row IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = target_table
    LOOP
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        policy_row.policyname,
        target_table
      );
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I
       FOR ALL TO authenticated
       USING (
         EXISTS (
           SELECT 1
           FROM public.admin_users au
           WHERE lower(au.email) = lower(auth.email())
         )
       )
       WITH CHECK (
         EXISTS (
           SELECT 1
           FROM public.admin_users au
           WHERE lower(au.email) = lower(auth.email())
         )
       )',
      'admin_manage_' || target_table,
      target_table
    );
  END LOOP;
END $$;

-- Studio availability previously depended on anonymous reads of bookings and
-- studio_details. Expose only the occupied resource and time.
CREATE OR REPLACE FUNCTION public.get_studio_occupancy(
  p_branch_id uuid,
  p_service_date date
)
RETURNS TABLE (
  studio_id uuid,
  timeslot text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sd.studio_id,
    sd.timeslot::text
  FROM public.studio_details sd
  JOIN public.bookings b ON b.id = sd.booking_id
  WHERE b.branch_id = p_branch_id
    AND sd.service_date = p_service_date
    AND b.status NOT IN ('cancelled', 'rejected');
$$;

REVOKE ALL ON FUNCTION public.get_studio_occupancy(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_studio_occupancy(uuid, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
