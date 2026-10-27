-- Human-applied release prerequisite. Does not change data or the view's columns/query.
-- A default-security view uses its owner's permissions and can bypass booking RLS.
-- Use the caller's permissions so existing admin-only bookings/hotel_details policies apply.
-- IF EXISTS permits environments that do not have this legacy view.
ALTER VIEW IF EXISTS public.bookings_needs_action
  SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';

-- Verify after applying: anonymous and ordinary customer requests return no rows;
-- authenticated staff retain access. Re-run the security advisor for this view.
