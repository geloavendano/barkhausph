-- Read-only payment health snapshot for external monitoring (GitHub Actions
-- canary → payment-health edge function → this RPC). Returns non-PII counts:
--   * stale_pending: online bookings still pending+unpaid past the 15-min window
--     (>30 min old) — the symptom that means SOMETHING in the expiry path is broken,
--     whatever the cause (dead cron, missing webhook, Maya outage, regression).
--   * cron_* : health of the cancel-pending-bookings job, so the canary also
--     surfaces a silently-failing cron directly (this incident's root cause).
--
-- SECURITY DEFINER so it can read the cron schema; created by an owner role
-- (e.g. the dashboard SQL editor / postgres) that has access to cron.*.

CREATE OR REPLACE FUNCTION public.payment_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE
  v_stale            int;
  v_refs             text[];
  v_job_id           bigint;
  v_last_status      text;
  v_last_run         timestamptz;
  v_recent_failures  int;
BEGIN
  SELECT count(*), (array_agg(ref_number ORDER BY created_at))[1:10]
    INTO v_stale, v_refs
  FROM public.bookings
  WHERE status = 'pending'
    AND payment_status = 'unpaid'
    AND booking_source = 'online'
    AND created_at < now() - interval '30 minutes';

  SELECT jobid INTO v_job_id
  FROM cron.job WHERE jobname = 'cancel-pending-bookings' LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    SELECT status, start_time INTO v_last_status, v_last_run
    FROM cron.job_run_details
    WHERE jobid = v_job_id
    ORDER BY start_time DESC
    LIMIT 1;

    SELECT count(*) INTO v_recent_failures
    FROM cron.job_run_details
    WHERE jobid = v_job_id
      AND status = 'failed'
      AND start_time > now() - interval '1 hour';
  END IF;

  RETURN jsonb_build_object(
    'checked_at',           now(),
    'stale_pending',        COALESCE(v_stale, 0),
    'stale_refs',           COALESCE(to_jsonb(v_refs), '[]'::jsonb),
    'cron_job_present',     v_job_id IS NOT NULL,
    'cron_last_status',     v_last_status,
    'cron_last_run',        v_last_run,
    'cron_recent_failures', COALESCE(v_recent_failures, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.payment_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_health() TO service_role;

-- After applying:  NOTIFY pgrst, 'reload schema';
