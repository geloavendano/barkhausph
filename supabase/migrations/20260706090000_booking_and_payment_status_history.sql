-- Append-only status histories captured at the database boundary. Because the
-- trigger runs for every INSERT/UPDATE on bookings, it covers Admin requests,
-- Edge Functions, webhooks, recovery functions, and scheduled database jobs.

CREATE TABLE public.booking_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id uuid,
  changed_by_email text,
  changed_by_role text,
  change_source text NOT NULL
);

CREATE INDEX booking_status_history_booking_changed_idx
  ON public.booking_status_history (booking_id, changed_at);

CREATE TABLE public.payment_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id uuid,
  changed_by_email text,
  changed_by_role text,
  change_source text NOT NULL
);

CREATE INDEX payment_status_history_booking_changed_idx
  ON public.payment_status_history (booking_id, changed_at);

ALTER TABLE public.booking_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_booking_status_history
  ON public.booking_status_history
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  );

CREATE POLICY admin_read_payment_status_history
  ON public.payment_status_history
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  );

GRANT SELECT ON public.booking_status_history TO authenticated;
GRANT SELECT ON public.payment_status_history TO authenticated;

CREATE OR REPLACE FUNCTION public.capture_booking_status_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claims jsonb := '{}'::jsonb;
  v_user_id uuid;
  v_email text;
  v_role text;
  v_source text;
BEGIN
  BEGIN
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_claims := '{}'::jsonb;
  END;

  BEGIN
    v_user_id := NULLIF(v_claims->>'sub', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_user_id := NULL;
  END;

  v_email := NULLIF(v_claims->>'email', '');
  v_role := COALESCE(NULLIF(v_claims->>'role', ''), current_user);
  v_source := CASE
    WHEN v_role = 'service_role' THEN 'service_role'
    WHEN v_email IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(v_email)
    ) THEN 'admin'
    WHEN v_email IS NOT NULL THEN 'authenticated'
    ELSE 'database'
  END;

  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.booking_status_history (
      booking_id, from_status, to_status, changed_at,
      changed_by_user_id, changed_by_email, changed_by_role, change_source
    ) VALUES (
      NEW.id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status,
      now(),
      v_user_id, v_email, v_role, v_source
    );
  END IF;

  IF TG_OP = 'INSERT' OR OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    INSERT INTO public.payment_status_history (
      booking_id, from_status, to_status, changed_at,
      changed_by_user_id, changed_by_email, changed_by_role, change_source
    ) VALUES (
      NEW.id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.payment_status END,
      NEW.payment_status,
      now(),
      v_user_id, v_email, v_role, v_source
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_booking_status_history() FROM PUBLIC;

CREATE TRIGGER capture_booking_status_history_trigger
AFTER INSERT OR UPDATE OF status, payment_status
ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.capture_booking_status_history();

COMMENT ON TABLE public.booking_status_history IS
  'Append-only history of all bookings.status movements from migration time onward.';
COMMENT ON TABLE public.payment_status_history IS
  'Append-only history of all bookings.payment_status movements from migration time onward.';

NOTIFY pgrst, 'reload schema';
