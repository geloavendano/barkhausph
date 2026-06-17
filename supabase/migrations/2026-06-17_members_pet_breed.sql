-- Add optional pet breed to membership records so staff can verify that a
-- membership code belongs to the expected pet during in-store validation.

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS pet_breed text;

COMMENT ON COLUMN public.members.pet_breed IS
  'Optional pet breed shown on admin membership validation for check-in verification.';
