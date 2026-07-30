-- Rate calendar dates let hotel pricing treat configured holidays as weekend-rate
-- days without hardcoding annual holiday lists in the public/admin frontends.

CREATE TABLE IF NOT EXISTS public.rate_calendar (
  rate_date date PRIMARY KEY,
  label text NOT NULL,
  holiday_type text NOT NULL,
  rate_day_type text NOT NULL DEFAULT 'weekend',
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT rate_calendar_holiday_type_valid
    CHECK (holiday_type IN ('regular_holiday', 'special_non_working')),
  CONSTRAINT rate_calendar_rate_day_type_valid
    CHECK (rate_day_type IN ('weekday', 'weekend'))
);

COMMENT ON TABLE public.rate_calendar IS
  'Dates that override the normal weekday/weekend hotel-rate classification.';

COMMENT ON COLUMN public.rate_calendar.rate_day_type IS
  'The pricing day_type to use for this date. Barkhaus holidays normally use weekend.';

ALTER TABLE public.rate_calendar ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_active_rate_calendar ON public.rate_calendar;
CREATE POLICY public_read_active_rate_calendar
  ON public.rate_calendar
  FOR SELECT
  TO anon, authenticated
  USING (active = true);

DROP POLICY IF EXISTS admin_manage_rate_calendar ON public.rate_calendar;
CREATE POLICY admin_manage_rate_calendar
  ON public.rate_calendar
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.admin_users au
      WHERE lower(au.email) = lower(auth.email())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.admin_users au
      WHERE lower(au.email) = lower(auth.email())
    )
  );

GRANT SELECT ON public.rate_calendar TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.rate_calendar TO authenticated;

-- Seed national 2026 regular holidays and special non-working holidays that
-- should be charged at the weekend hotel rate. Add or update rows as later
-- presidential proclamations set movable holidays.
INSERT INTO public.rate_calendar (rate_date, label, holiday_type, rate_day_type, active)
VALUES
  ('2026-01-01', 'New Year''s Day', 'regular_holiday', 'weekend', true),
  ('2026-02-17', 'Chinese New Year', 'special_non_working', 'weekend', true),
  ('2026-03-20', 'Eidul Fitr', 'regular_holiday', 'weekend', true),
  ('2026-04-02', 'Maundy Thursday', 'regular_holiday', 'weekend', true),
  ('2026-04-03', 'Good Friday', 'regular_holiday', 'weekend', true),
  ('2026-04-04', 'Black Saturday', 'special_non_working', 'weekend', true),
  ('2026-04-09', 'Araw ng Kagitingan', 'regular_holiday', 'weekend', true),
  ('2026-05-01', 'Labor Day', 'regular_holiday', 'weekend', true),
  ('2026-05-27', 'Eidul Adha', 'regular_holiday', 'weekend', true),
  ('2026-06-12', 'Independence Day', 'regular_holiday', 'weekend', true),
  ('2026-08-21', 'Ninoy Aquino Day', 'special_non_working', 'weekend', true),
  ('2026-08-31', 'National Heroes Day', 'regular_holiday', 'weekend', true),
  ('2026-11-01', 'All Saints'' Day', 'special_non_working', 'weekend', true),
  ('2026-11-02', 'All Souls'' Day', 'special_non_working', 'weekend', true),
  ('2026-11-30', 'Bonifacio Day', 'regular_holiday', 'weekend', true),
  ('2026-12-08', 'Feast of the Immaculate Conception', 'special_non_working', 'weekend', true),
  ('2026-12-24', 'Christmas Eve', 'special_non_working', 'weekend', true),
  ('2026-12-25', 'Christmas Day', 'regular_holiday', 'weekend', true),
  ('2026-12-30', 'Rizal Day', 'regular_holiday', 'weekend', true),
  ('2026-12-31', 'Last Day of the Year', 'special_non_working', 'weekend', true)
ON CONFLICT (rate_date) DO UPDATE
SET label = EXCLUDED.label,
    holiday_type = EXCLUDED.holiday_type,
    rate_day_type = EXCLUDED.rate_day_type,
    active = EXCLUDED.active,
    updated_at = now();

NOTIFY pgrst, 'reload schema';
