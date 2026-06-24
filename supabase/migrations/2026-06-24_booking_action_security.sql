-- Authorization state for uploads, customer cancellation, and walk-in booking
-- submissions. Edge Functions use the service role for these private records.

BEGIN;

ALTER TABLE public.pending_bookings
  ADD COLUMN IF NOT EXISTS cancellation_token_hash text;

CREATE INDEX IF NOT EXISTS pending_bookings_cancellation_token_hash_idx
  ON public.pending_bookings (cancellation_token_hash)
  WHERE cancellation_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.pending_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  bucket_id text NOT NULL,
  object_path text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (
    purpose IN ('vaccine_document', 'grooming_reference', 'manual_payment_receipt')
  ),
  content_type text NOT NULL,
  max_size_bytes integer NOT NULL CHECK (max_size_bytes > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_uploads_active_idx
  ON public.pending_uploads (token_hash, expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.pending_uploads ENABLE ROW LEVEL SECURITY;

-- Walk-in tokens are minted by allow-listed admins but are consumed only by the
-- submit-booking Edge Function. Anonymous browsers no longer read or delete
-- these rows directly.
DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'walkin_tokens'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.walkin_tokens', policy_row.policyname);
  END LOOP;
END $$;

ALTER TABLE public.walkin_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_manage_walkin_tokens
  ON public.walkin_tokens
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE lower(au.email) = lower(auth.email())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE lower(au.email) = lower(auth.email())
    )
  );

-- Do not reveal booking UUIDs through public availability responses.
DROP FUNCTION IF EXISTS public.get_grooming_occupancy(uuid, date);

CREATE FUNCTION public.get_grooming_occupancy(
  p_branch_id uuid,
  p_service_date date
)
RETURNS TABLE (
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

REVOKE ALL ON FUNCTION public.get_grooming_occupancy(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_grooming_occupancy(uuid, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
