-- Repoint the expiry cron to reconcile-with-Maya-before-cancelling.
--
-- Root cause it fixes: expire_pending_bookings() is pure SQL and cannot ask Maya
-- whether a hold was actually paid, so QRPH payers whose success webhook never
-- arrived got cancelled despite paying (e.g. BH-E0D9B8). The cron now calls the
-- reconcile-maya-bookings edge function, which checks Maya first and only cancels
-- when Maya confirms no payment (and heals recently-cancelled paid bookings too).
--
-- Requires the pg_net extension (net.http_post). expire_pending_bookings() is kept
-- defined as a manual backstop but is no longer scheduled.
--
-- ⚠️ BEFORE APPLYING: replace <<RECONCILE_TOKEN>> below with the same value set as
--    the RECONCILE_TOKEN env var on the reconcile-maya-bookings function. Keep this
--    file's committed copy as the placeholder — do NOT commit the real token.

-- Enable pg_net if it isn't already (provides net.http_post). If your project
-- already has it enabled (Database → Extensions), this is a harmless no-op.
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE existing_job record;
BEGIN
  FOR existing_job IN SELECT jobid FROM cron.job WHERE jobname = 'cancel-pending-bookings' LOOP
    PERFORM cron.unschedule(existing_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'cancel-pending-bookings',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://dxttnbtfhpanyiyduevn.supabase.co/functions/v1/reconcile-maya-bookings',
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-reconcile-token', '<<RECONCILE_TOKEN>>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Rollback (revert to the SQL-only expiry job):
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cancel-pending-bookings';
--   SELECT cron.schedule('cancel-pending-bookings', '*/5 * * * *',
--                        $$SELECT public.expire_pending_bookings();$$);
