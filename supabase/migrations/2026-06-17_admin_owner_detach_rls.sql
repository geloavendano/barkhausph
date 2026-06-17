-- Allow dashboard admins to detach shared owner records during booking edits.
--
-- The admin edit flow may create a new owners row when the previous owner
-- record is shared. Public booking creation still goes through Edge
-- Functions/service role.

ALTER TABLE public.owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_manage_owners ON public.owners;

CREATE POLICY admin_manage_owners
  ON public.owners
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE email = auth.email())
  );

NOTIFY pgrst, 'reload schema';
