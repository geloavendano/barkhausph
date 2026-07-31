-- Harden booking attachment storage layout.
--
-- New uploads should be stored only in the private vaccine-docs bucket under:
--   uploads/vaccine_document/{yyyy}/{mm}/{dd}/{uploadId}/...
--   uploads/grooming_reference/{yyyy}/{mm}/{dd}/{uploadId}/...
--   uploads/manual_payment_receipt/{yyyy}/{mm}/{dd}/{uploadId}/...
--
-- The CHECK constraints are NOT VALID so historical rows with legacy/bad paths
-- remain inspectable, but new inserts/updates must use the organized prefixes.

BEGIN;

INSERT INTO storage.buckets (
  id,
  name,
  "public",
  file_size_limit,
  allowed_mime_types
) VALUES (
  'vaccine-docs',
  'vaccine-docs',
  false,
  10 * 1024 * 1024,
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
    'image/heic', 'image/heif', 'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
SET "public" = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

ALTER TABLE public.vaccine_documents
  DROP CONSTRAINT IF EXISTS vaccine_documents_file_path_upload_prefix;

ALTER TABLE public.vaccine_documents
  ADD CONSTRAINT vaccine_documents_file_path_upload_prefix
  CHECK (file_path LIKE 'uploads/vaccine_document/%') NOT VALID;

ALTER TABLE public.grooming_reference_images
  DROP CONSTRAINT IF EXISTS grooming_reference_images_file_path_upload_prefix;

ALTER TABLE public.grooming_reference_images
  ADD CONSTRAINT grooming_reference_images_file_path_upload_prefix
  CHECK (file_path LIKE 'uploads/grooming_reference/%') NOT VALID;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_receipt_path_upload_prefix;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_receipt_path_upload_prefix
  CHECK (
    receipt_path IS NULL
    OR receipt_path LIKE 'uploads/manual_payment_receipt/%'
  ) NOT VALID;

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
      WHERE lower(email) = lower(auth.email())
    )
  );

COMMIT;
