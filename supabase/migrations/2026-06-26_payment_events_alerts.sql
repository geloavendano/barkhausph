-- Audit trail for hosted payment provider webhook events.
-- Written by Edge Functions with the service-role key. RLS is enabled so the
-- public booking site cannot read payment event history.

CREATE TABLE IF NOT EXISTS public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  event_type text,
  payment_status text,
  ref_number text,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  pending_booking_id uuid REFERENCES public.pending_bookings(id) ON DELETE SET NULL,
  gateway_checkout_id text,
  gateway_payment_id text,
  amount numeric,
  currency text,
  payment_channel text,
  alert_sent boolean NOT NULL DEFAULT false,
  alert_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS payment_events_provider_created_at_idx
  ON public.payment_events (provider, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_events_ref_number_idx
  ON public.payment_events (ref_number)
  WHERE ref_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_events_gateway_payment_id_idx
  ON public.payment_events (gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payment_events IS
  'Audit trail for hosted payment provider webhook events and operational alerts.';
COMMENT ON COLUMN public.payment_events.metadata IS
  'Sanitized provider metadata for debugging. Do not store API keys or full customer payloads.';

NOTIFY pgrst, 'reload schema';
