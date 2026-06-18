-- Provider-neutral payment fields for Maya Checkout while preserving the
-- dormant PayMongo integration and its legacy paymongo_link_id column.

ALTER TABLE public.pending_bookings
  ADD COLUMN IF NOT EXISTS payment_provider text,
  ADD COLUMN IF NOT EXISTS gateway_checkout_id text,
  ADD COLUMN IF NOT EXISTS gateway_payment_id text;

CREATE INDEX IF NOT EXISTS pending_bookings_gateway_checkout_id_idx
  ON public.pending_bookings (gateway_checkout_id)
  WHERE gateway_checkout_id IS NOT NULL;

COMMENT ON COLUMN public.pending_bookings.payment_provider IS
  'Online checkout provider: maya or paymongo. Manual transfers do not use pending_bookings.';
COMMENT ON COLUMN public.pending_bookings.gateway_checkout_id IS
  'Provider checkout/session identifier used to correlate payment webhooks.';
COMMENT ON COLUMN public.pending_bookings.gateway_payment_id IS
  'Provider payment identifier populated when available.';

-- The scheduler should call this helper instead of cancelling by a fixed age.
-- It lets each provider define the correct hold duration through expires_at.
CREATE OR REPLACE FUNCTION public.expire_pending_bookings()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.bookings AS b
  SET status = 'cancelled',
      cancellation_reason = COALESCE(b.cancellation_reason, 'Payment window expired')
  WHERE b.status = 'pending'
    AND b.payment_status = 'unpaid'
    AND EXISTS (
      SELECT 1
      FROM public.pending_bookings AS p
      WHERE p.ref_number = b.ref_number
        AND p.expires_at <= now()
    );

  DELETE FROM public.pending_bookings
  WHERE expires_at <= now();
END;
$$;

REVOKE ALL ON FUNCTION public.expire_pending_bookings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_pending_bookings() TO service_role;

NOTIFY pgrst, 'reload schema';
