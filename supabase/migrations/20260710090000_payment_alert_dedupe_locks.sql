-- Dedupe operational payment alert emails while preserving every webhook event
-- in payment_events for audit/debugging.

CREATE TABLE IF NOT EXISTS public.payment_alert_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  alert_key text NOT NULL UNIQUE,
  ref_number text,
  event_type text,
  gateway_payment_id text,
  gateway_checkout_id text,
  first_payment_event_id uuid REFERENCES public.payment_events(id) ON DELETE SET NULL,
  last_payment_event_id uuid REFERENCES public.payment_events(id) ON DELETE SET NULL,
  send_count integer NOT NULL DEFAULT 0,
  alert_sent boolean NOT NULL DEFAULT false,
  alert_error text
);

CREATE INDEX IF NOT EXISTS payment_alert_locks_ref_number_idx
  ON public.payment_alert_locks (ref_number)
  WHERE ref_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_alert_locks_created_at_idx
  ON public.payment_alert_locks (created_at DESC);

ALTER TABLE public.payment_alert_locks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payment_alert_locks IS
  'One-row-per-payment-alert lock table used to suppress duplicate operational emails from repeated provider webhooks.';

NOTIFY pgrst, 'reload schema';
