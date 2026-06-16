-- Grooming "peg" / reference photos.
-- On the public booking flow, grooming customers can attach reference images
-- (inspiration pegs) alongside their special-requests note. Each uploaded image
-- is PUT to the existing private `vaccine-docs` storage bucket via get-upload-url,
-- and submit-booking records one row per file here. The admin booking drawer
-- renders them through short-lived signed URLs (same pattern as vaccine_documents).
--
-- Mirrors public.vaccine_documents (booking_id + file_path + file_name).

CREATE TABLE IF NOT EXISTS public.grooming_reference_images (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  file_path  text        NOT NULL,
  file_name  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grooming_reference_images_booking_id_idx
  ON public.grooming_reference_images (booking_id);

COMMENT ON TABLE public.grooming_reference_images IS
  'Reference/inspiration photos ("pegs") attached to a grooming booking. Files live in the private vaccine-docs bucket; file_path is the storage path.';

-- RLS: admins (matched on JWT email) can read/manage; submit-booking inserts as
-- the service role and bypasses RLS entirely.
ALTER TABLE public.grooming_reference_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_manage_grooming_reference_images ON public.grooming_reference_images;

CREATE POLICY admin_manage_grooming_reference_images
  ON public.grooming_reference_images
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  );

-- Reload PostgREST schema cache after applying:
--   NOTIFY pgrst, 'reload schema';
