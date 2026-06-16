-- Admin audit fields for dashboard-created bookings, booking edits, and payments.
--
-- Apply this before relying on the new dashboard audit display. The admin app
-- has a compatibility fallback so saves still work before this migration, but
-- the added-by / edited-by / recorded-by columns only persist after these
-- columns exist in Supabase.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS created_by_admin_id uuid,
  ADD COLUMN IF NOT EXISTS created_by_auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS created_by_admin_name text,
  ADD COLUMN IF NOT EXISTS created_by_admin_email text;

COMMENT ON COLUMN public.bookings.created_by_admin_id IS
  'admin_users.id for the dashboard user who created this booking.';
COMMENT ON COLUMN public.bookings.created_by_auth_user_id IS
  'auth.users.id for the dashboard user who created this booking.';
COMMENT ON COLUMN public.bookings.created_by_admin_name IS
  'Display name of the dashboard user who created this booking.';
COMMENT ON COLUMN public.bookings.created_by_admin_email IS
  'Email of the dashboard user who created this booking.';

ALTER TABLE IF EXISTS public.booking_edits
  ADD COLUMN IF NOT EXISTS edited_by_admin_id uuid,
  ADD COLUMN IF NOT EXISTS edited_by_auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS edited_by_email text;

COMMENT ON COLUMN public.booking_edits.edited_by_admin_id IS
  'admin_users.id for the dashboard user who made this edit.';
COMMENT ON COLUMN public.booking_edits.edited_by_auth_user_id IS
  'auth.users.id for the dashboard user who made this edit.';
COMMENT ON COLUMN public.booking_edits.edited_by_email IS
  'Email of the dashboard user who made this edit.';

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS recorded_by_admin_id uuid,
  ADD COLUMN IF NOT EXISTS recorded_by_auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS recorded_by_email text;

COMMENT ON COLUMN public.payments.recorded_by_admin_id IS
  'admin_users.id for the dashboard user who recorded this payment.';
COMMENT ON COLUMN public.payments.recorded_by_auth_user_id IS
  'auth.users.id for the dashboard user who recorded this payment.';
COMMENT ON COLUMN public.payments.recorded_by_email IS
  'Email of the dashboard user who recorded this payment.';
