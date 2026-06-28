-- Retire the legacy fixed-age timeout job. Its direct UPDATE can race with
-- payment finalization and overwrite a newly confirmed booking's status.
-- The provider-aware helper only expires the current pending hold and requires
-- the booking to remain both pending and unpaid.

DO $$
DECLARE
  existing_job record;
BEGIN
  FOR existing_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'cancel-pending-bookings'
  LOOP
    PERFORM cron.unschedule(existing_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'cancel-pending-bookings',
  '*/5 * * * *',
  $$SELECT public.expire_pending_bookings();$$
);
