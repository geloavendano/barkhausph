-- Allow authenticated Barkhaus admins to create signed read URLs for files in
-- the private vaccine-docs bucket. This bucket also stores grooming reference
-- photos ("pegs") and manual-payment receipts.

DROP POLICY IF EXISTS admin_read_vaccine_docs_storage ON storage.objects;

CREATE POLICY admin_read_vaccine_docs_storage
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'vaccine-docs'
    AND EXISTS (
      SELECT 1
      FROM public.admin_users
      WHERE email = auth.email()
    )
  );
