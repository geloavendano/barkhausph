-- Fix: admin-created / admin-edited bookings and booking_charges RLS
--
-- Symptom 1 — create: ERROR 42501 "new row violates row-level security policy
--   for table booking_charges" when an admin saves a booking.
-- Symptom 2 — edit: duplicate base_service charge rows accumulate. An earlier
--   INSERT-only policy (admin_insert_booking_charges) let new charges in but the
--   edit flow's DELETE of the old charges was still blocked, so stale rows were
--   never removed and piled up on every edit.
--
-- Cause: the admin app writes booking_charges as the logged-in (authenticated)
-- admin user. RLS needs a policy covering ALL of SELECT/INSERT/UPDATE/DELETE for
-- that role. The PayMongo webhook is unaffected — it runs as the service role,
-- which bypasses RLS.
--
-- Fix: one FOR ALL policy for users in admin_users (matched on JWT email).
-- Idempotent — drops any earlier admin policies (incl. the INSERT-only one) first.
--
-- Inspect existing policies (optional):
--   SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'booking_charges';

DROP POLICY IF EXISTS admin_insert_booking_charges ON public.booking_charges;
DROP POLICY IF EXISTS admin_delete_booking_charges ON public.booking_charges;
DROP POLICY IF EXISTS admin_manage_booking_charges ON public.booking_charges;

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
