-- Serialize hosted-checkout inventory reservations and throttle anonymous
-- upload authorizations.

BEGIN;

UPDATE storage.buckets
SET file_size_limit = 10 * 1024 * 1024,
    allowed_mime_types = ARRAY[
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
      'image/heic', 'image/heif', 'application/pdf'
    ]
WHERE id = 'vaccine-docs';

ALTER TABLE public.pending_uploads
  ADD COLUMN IF NOT EXISTS fingerprint_hash text;

CREATE INDEX IF NOT EXISTS pending_uploads_fingerprint_active_idx
  ON public.pending_uploads (fingerprint_hash, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.inventory_mutexes (
  lock_key text PRIMARY KEY,
  lock_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inventory_mutexes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.acquire_inventory_mutex(
  p_lock_key text,
  p_lock_token text,
  p_ttl_seconds integer DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.inventory_mutexes
  WHERE lock_key = p_lock_key AND expires_at <= now();

  INSERT INTO public.inventory_mutexes (lock_key, lock_token, expires_at)
  VALUES (
    p_lock_key,
    p_lock_token,
    now() + make_interval(secs => greatest(5, least(p_ttl_seconds, 120)))
  )
  ON CONFLICT (lock_key) DO NOTHING;

  RETURN EXISTS (
    SELECT 1 FROM public.inventory_mutexes
    WHERE lock_key = p_lock_key AND lock_token = p_lock_token
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_inventory_mutex(
  p_lock_key text,
  p_lock_token text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.inventory_mutexes
  WHERE lock_key = p_lock_key AND lock_token = p_lock_token;
$$;

REVOKE ALL ON FUNCTION public.acquire_inventory_mutex(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory_mutex(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_inventory_mutex(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_inventory_mutex(text, text) TO service_role;

CREATE TABLE IF NOT EXISTS public.upload_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint_hash text NOT NULL,
  purpose text NOT NULL,
  declared_size_bytes integer NOT NULL CHECK (declared_size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS upload_request_log_client_time_idx
  ON public.upload_request_log (fingerprint_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_request_log_time_idx
  ON public.upload_request_log (created_at DESC);

ALTER TABLE public.upload_request_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.authorize_upload_request(
  p_fingerprint_hash text,
  p_purpose text,
  p_declared_size_bytes integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  client_ten_minute_count integer;
  client_hour_count integer;
  client_hour_bytes bigint;
  global_hour_count integer;
  global_hour_bytes bigint;
BEGIN
  -- Serialize quota checks so parallel requests cannot all pass before logging.
  PERFORM pg_advisory_xact_lock(hashtextextended('barkhaus-upload-quota', 0));

  DELETE FROM public.upload_request_log
  WHERE created_at < now() - interval '24 hours';

  SELECT
    count(*) FILTER (WHERE created_at >= now() - interval '10 minutes'),
    count(*) FILTER (WHERE created_at >= now() - interval '1 hour'),
    coalesce(sum(declared_size_bytes) FILTER (
      WHERE created_at >= now() - interval '1 hour'
    ), 0)
  INTO client_ten_minute_count, client_hour_count, client_hour_bytes
  FROM public.upload_request_log
  WHERE fingerprint_hash = p_fingerprint_hash;

  IF client_ten_minute_count >= 15 THEN RETURN 'Too many upload requests. Please try again later.'; END IF;
  IF client_hour_count >= 30 THEN RETURN 'Hourly upload request limit reached.'; END IF;
  IF client_hour_bytes + p_declared_size_bytes > 100 * 1024 * 1024 THEN
    RETURN 'Hourly upload size limit reached.';
  END IF;

  SELECT count(*), coalesce(sum(declared_size_bytes), 0)
  INTO global_hour_count, global_hour_bytes
  FROM public.upload_request_log
  WHERE created_at >= now() - interval '1 hour';

  IF global_hour_count >= 300 THEN RETURN 'Upload service is temporarily busy.'; END IF;
  IF global_hour_bytes + p_declared_size_bytes > 1024::bigint * 1024 * 1024 THEN
    RETURN 'Upload service capacity reached. Please try again later.';
  END IF;

  INSERT INTO public.upload_request_log (
    fingerprint_hash, purpose, declared_size_bytes
  ) VALUES (
    p_fingerprint_hash, p_purpose, p_declared_size_bytes
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_upload_request(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_upload_request(text, text, integer) TO service_role;

COMMIT;
