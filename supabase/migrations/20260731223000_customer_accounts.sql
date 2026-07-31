-- Customer accounts for the public Barkhaus website.
--
-- Authentication remains in Supabase Auth, but customer authorization is
-- deliberately separate from admin_users. The same verified email may have
-- both an admin allow-list row and a customer account without either role
-- implying the other.

BEGIN;

ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS feeding_instructions text,
  ADD COLUMN IF NOT EXISTS medications text,
  ADD COLUMN IF NOT EXISTS vet_clinic text,
  ADD COLUMN IF NOT EXISTS vet_contact text,
  ADD COLUMN IF NOT EXISTS vet_address text,
  ADD COLUMN IF NOT EXISTS emergency_name text,
  ADD COLUMN IF NOT EXISTS emergency_phone text,
  ADD COLUMN IF NOT EXISTS membership_code text,
  ADD COLUMN IF NOT EXISTS vaccine_valid_until date,
  ADD COLUMN IF NOT EXISTS bring_vaccine_records boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS public.customer_accounts (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL UNIQUE REFERENCES public.owners(id) ON DELETE RESTRICT,
  email text NOT NULL,
  auth_provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_accounts_email_lower_idx
  ON public.customer_accounts (lower(email));

CREATE TABLE IF NOT EXISTS public.pet_profile_vaccines (
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  vaccine_key text NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  valid_until date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pet_id, vaccine_key),
  CONSTRAINT pet_profile_vaccines_key_length
    CHECK (char_length(vaccine_key) BETWEEN 1 AND 100)
);

CREATE TABLE IF NOT EXISTS public.pet_vaccine_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE RESTRICT,
  file_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text,
  file_size_bytes bigint,
  valid_until date,
  active boolean NOT NULL DEFAULT true,
  uploaded_by_auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT pet_vaccine_documents_path_prefix
    CHECK (file_path LIKE 'uploads/vaccine_document/accounts/%'),
  CONSTRAINT pet_vaccine_documents_size_positive
    CHECK (file_size_bytes IS NULL OR file_size_bytes > 0)
);

CREATE INDEX IF NOT EXISTS pet_vaccine_documents_pet_active_idx
  ON public.pet_vaccine_documents (pet_id, active);

ALTER TABLE public.customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pet_profile_vaccines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pet_vaccine_documents ENABLE ROW LEVEL SECURITY;

-- Browser customers use the customer-account Edge Function. Direct table
-- access remains closed. Admins retain authenticated access for support and
-- record review; the service role used by Edge Functions bypasses RLS.
DROP POLICY IF EXISTS admin_manage_customer_accounts ON public.customer_accounts;
CREATE POLICY admin_manage_customer_accounts
  ON public.customer_accounts
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  );

DROP POLICY IF EXISTS admin_manage_pet_profile_vaccines ON public.pet_profile_vaccines;
CREATE POLICY admin_manage_pet_profile_vaccines
  ON public.pet_profile_vaccines
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  );

DROP POLICY IF EXISTS admin_manage_pet_vaccine_documents ON public.pet_vaccine_documents;
CREATE POLICY admin_manage_pet_vaccine_documents
  ON public.pet_vaccine_documents
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE lower(email) = lower(auth.email())
    )
  );

REVOKE ALL ON public.customer_accounts FROM anon;
REVOKE ALL ON public.pet_profile_vaccines FROM anon;
REVOKE ALL ON public.pet_vaccine_documents FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pet_profile_vaccines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pet_vaccine_documents TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
