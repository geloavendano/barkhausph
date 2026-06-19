-- Date-specific service hours for inventory resources.
-- Groomers consume this first; the polymorphic shape is ready for rooms/studios later.

CREATE TABLE IF NOT EXISTS public.resource_service_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  resource_type text NOT NULL CHECK (resource_type IN ('groomer', 'room', 'studio')),
  resource_id uuid NOT NULL,
  service_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  last_service_time time NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_service_hours_valid_window CHECK (start_time < end_time),
  CONSTRAINT resource_service_hours_valid_last_service CHECK (
    last_service_time >= start_time AND last_service_time <= end_time
  ),
  CONSTRAINT resource_service_hours_resource_date_key UNIQUE (resource_type, resource_id, service_date)
);

CREATE INDEX IF NOT EXISTS resource_service_hours_branch_date_idx
  ON public.resource_service_hours (branch_id, resource_type, service_date)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS resource_service_hours_resource_date_idx
  ON public.resource_service_hours (resource_type, resource_id, service_date)
  WHERE active = true;

ALTER TABLE public.resource_service_hours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public reads active resource service hours" ON public.resource_service_hours;
CREATE POLICY "Public reads active resource service hours"
  ON public.resource_service_hours FOR SELECT
  USING (active = true);

DROP POLICY IF EXISTS "Admins manage resource service hours" ON public.resource_service_hours;
CREATE POLICY "Admins manage resource service hours"
  ON public.resource_service_hours FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_users au WHERE lower(au.email) = lower(auth.email())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.admin_users au WHERE lower(au.email) = lower(auth.email())
  ));

-- Preserve the previous always-available behavior for 90 days, giving staff time to
-- replace the defaults from Inventory. The former UI offered starts through 17:00;
-- 19:00 allows the longest standard two-hour service to finish.
INSERT INTO public.resource_service_hours (
  branch_id, resource_type, resource_id, service_date,
  start_time, end_time, last_service_time, active
)
SELECT
  g.branch_id,
  'groomer',
  g.id,
  d::date,
  time '09:00',
  time '19:00',
  time '17:00',
  true
FROM public.groomers g
CROSS JOIN generate_series(current_date, current_date + 89, interval '1 day') d
WHERE g.active = true AND coalesce(g.is_unavailable, false) = false
ON CONFLICT (resource_type, resource_id, service_date) DO NOTHING;

-- Convert legacy weekday blocks into explicit blocked dates for the seeded service-hour
-- horizon. One legacy rule becomes one blocked_schedules row containing its matching dates.
INSERT INTO public.blocked_schedules (
  branch_id, resource_type, resource_id, dates,
  start_time, end_time, reason, active
)
SELECT
  g.branch_id,
  'groomer',
  gb.groomer_id,
  array_agg(rsh.service_date ORDER BY rsh.service_date),
  gb.start_time,
  gb.end_time,
  nullif(gb.label, ''),
  true
FROM public.groomer_blocks gb
JOIN public.groomers g ON g.id = gb.groomer_id
JOIN public.resource_service_hours rsh
  ON rsh.resource_type = 'groomer'
 AND rsh.resource_id = gb.groomer_id
 AND rsh.active = true
 AND (
   coalesce(cardinality(gb.days_of_week), 0) = 0
   OR extract(dow FROM rsh.service_date)::integer = ANY(gb.days_of_week)
 )
WHERE gb.active = true
GROUP BY g.branch_id, gb.id, gb.groomer_id, gb.start_time, gb.end_time, gb.label
HAVING count(*) > 0;

-- The application stops reading this legacy table in the accompanying release.
UPDATE public.groomer_blocks SET active = false WHERE active = true;

NOTIFY pgrst, 'reload schema';
