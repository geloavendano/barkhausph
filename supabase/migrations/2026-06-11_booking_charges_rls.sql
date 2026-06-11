-- Fix: admin-created / admin-edited bookings fail to write booking_charges
--   ERROR 42501: new row violates row-level security policy for table "booking_charges"
--
-- Cause: the admin app writes booking_charges as the logged-in (authenticated)
-- admin user. RLS was enabled with no INSERT/DELETE policy for that role, so the
-- write was rejected. The public flow works because the PayMongo webhook runs as
-- the service role, which bypasses RLS.
--
-- Fix: allow any user listed in admin_users (matched on their JWT email) to fully
-- manage booking_charges. FOR ALL covers SELECT/INSERT/UPDATE/DELETE in one policy.
-- Service role continues to bypass RLS, so the webhook is unaffected.
--
-- The admin app performs INSERT (create), DELETE + INSERT (edit refresh), and
-- SELECT (drawer bill) on this table — all covered here.

CREATE POLICY admin_manage_booking_charges
  ON public.booking_charges
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  );

-- If you prefer the minimal change (just unblock the create/edit writes that
-- were failing) instead of the FOR ALL policy above, use these two instead:
--
-- CREATE POLICY admin_insert_booking_charges ON public.booking_charges
--   FOR INSERT TO authenticated
--   WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email()));
--
-- CREATE POLICY admin_delete_booking_charges ON public.booking_charges
--   FOR DELETE TO authenticated
--   USING (EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email()));
