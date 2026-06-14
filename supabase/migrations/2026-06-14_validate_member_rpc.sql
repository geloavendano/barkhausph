-- Update the public membership-validation RPC used by the booking flow.
--
-- The booking page runs on the anon key and cannot read the members table directly,
-- so it calls this SECURITY DEFINER function. Previously it returned only the code +
-- pet name, so the public flow could not check tier, branch, expiry, or active state.
-- It now returns those fields; booking.js enforces:
--   • active = true
--   • valid_until not past
--   • Standard (branch-bound) memberships only discount at their home branch;
--     Passport (branch_id NULL) memberships discount at any branch
--   • pet name matches
--
-- DROP + CREATE (in a transaction) because the return type may differ from the
-- previous definition; CREATE OR REPLACE cannot change a function's return type.

BEGIN;

DROP FUNCTION IF EXISTS public.validate_member(text);

CREATE FUNCTION public.validate_member(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'member_code', member_code,
    'pet_name',    pet_name,
    'tier',        tier,
    'branch_id',   branch_id,
    'valid_until', valid_until,
    'active',      active
  )
  FROM public.members
  WHERE upper(member_code) = upper(p_code)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.validate_member(text) TO anon, authenticated;

COMMIT;
