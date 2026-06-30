-- Keep branch coverage (tier) separate from the temporary discount program.
-- tier: standard/passport
-- membership_type: standard/renewal

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS membership_type text NOT NULL DEFAULT 'standard';

ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS members_membership_type_valid;

ALTER TABLE public.members
  ADD CONSTRAINT members_membership_type_valid
  CHECK (membership_type IN ('standard', 'renewal'));

ALTER TABLE public.pricing
  ADD COLUMN IF NOT EXISTS membership_type text;

UPDATE public.pricing
SET membership_type = 'standard'
WHERE category = 'member_discount'
  AND membership_type IS NULL;

ALTER TABLE public.pricing
  DROP CONSTRAINT IF EXISTS pricing_membership_type_valid;

ALTER TABLE public.pricing
  ADD CONSTRAINT pricing_membership_type_valid
  CHECK (
    category <> 'member_discount'
    OR membership_type IN ('standard', 'renewal')
  );

-- Correct the standard Pet Hotel discount from 20% to 10%.
UPDATE public.pricing
SET price = 10,
    updated_at = now()
WHERE category = 'member_discount'
  AND service_key = 'hotel'
  AND membership_type = 'standard';

-- Renewals receive 20% specifically for Pet Hotel. Other services fall back
-- to their standard membership discount unless a renewal override is added.
INSERT INTO public.pricing (
  category,
  service_key,
  size_key,
  day_type,
  membership_type,
  price,
  updated_at
)
SELECT
  'member_discount',
  'hotel',
  NULL,
  NULL,
  'renewal',
  20,
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.pricing
  WHERE category = 'member_discount'
    AND service_key = 'hotel'
    AND membership_type = 'renewal'
);

CREATE OR REPLACE FUNCTION public.validate_member(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'member_code',     member_code,
    'pet_name',        pet_name,
    'tier',            tier,
    'membership_type', membership_type,
    'branch_id',       branch_id,
    'valid_until',     valid_until,
    'active',          active
  )
  FROM public.members
  WHERE upper(member_code) = upper(p_code)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.validate_member(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
