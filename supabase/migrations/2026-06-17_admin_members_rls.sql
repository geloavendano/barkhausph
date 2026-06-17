-- Allow dashboard admins to manage membership records through the Members page.
--
-- The CSV uploader runs in the authenticated admin browser and writes directly
-- to public.members via PostgREST, so RLS must allow admins to select/upsert.

ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_manage_members ON public.members;

CREATE POLICY admin_manage_members
  ON public.members
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  );

NOTIFY pgrst, 'reload schema';
