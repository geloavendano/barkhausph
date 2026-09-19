-- Security fix: rules that trusted ANY signed-in user now require an admin.
--
-- These rules date from when only admins could sign in, so "signed in" meant "admin". That stopped
-- being true: Supabase creates a signed-in session for any Google account that clicks the admin's
-- "Sign in with Google" (the admin app's admin_users check runs only in the browser), and email
-- sign-ups are open for customer accounts. Any such account could read every owner's contact details,
-- pets' medical notes and vaccine files, and write payments, rooms, groomers and check-in notes.
-- Verified on staging 2026-09-20 with a non-admin session.
--
-- Each open rule is replaced by the same rule restricted to admin_users (same commands, same tables),
-- so admin behaviour is unchanged. Public pages are unaffected: they use the anonymous role and their
-- own "…are readable" rules. Customers are unaffected: customer-account uses the service role.
-- Safe to re-run.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users a
    where lower(a.email) = lower(auth.email())
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Tables: read-only rules that were open to any signed-in user.
drop policy if exists "owners readable by authenticated"      on public.owners;
drop policy if exists "pets readable by authenticated"        on public.pets;
drop policy if exists "members readable by authenticated"     on public.members;
drop policy if exists "Authenticated read vaccine_documents"  on public.vaccine_documents;
drop policy if exists "authenticated_select"                  on public.booking_addons;
drop policy if exists "authenticated_select"                  on public.pet_vaccines;

drop policy if exists "owners readable by admins"             on public.owners;
drop policy if exists "pets readable by admins"               on public.pets;
drop policy if exists "members readable by admins"            on public.members;
drop policy if exists "vaccine_documents readable by admins"  on public.vaccine_documents;
drop policy if exists "booking_addons readable by admins"     on public.booking_addons;
drop policy if exists "pet_vaccines readable by admins"       on public.pet_vaccines;

create policy "owners readable by admins"            on public.owners            for select to authenticated using (public.is_admin());
create policy "pets readable by admins"              on public.pets              for select to authenticated using (public.is_admin());
create policy "members readable by admins"           on public.members           for select to authenticated using (public.is_admin());
create policy "vaccine_documents readable by admins" on public.vaccine_documents for select to authenticated using (public.is_admin());
create policy "booking_addons readable by admins"    on public.booking_addons    for select to authenticated using (public.is_admin());
create policy "pet_vaccines readable by admins"      on public.pet_vaccines      for select to authenticated using (public.is_admin());

-- Tables: read + write rules that were open to any signed-in user.
drop policy if exists "payments write authenticated"        on public.payments;
drop policy if exists "rooms write authenticated"           on public.rooms;
drop policy if exists "groomers write authenticated"        on public.groomers;
drop policy if exists "groomer_blocks write authenticated"  on public.groomer_blocks;
drop policy if exists "checkin_notes write authenticated"   on public.checkin_notes;
drop policy if exists "booking_edits write authenticated"   on public.booking_edits;

drop policy if exists "payments admin all"        on public.payments;
drop policy if exists "rooms admin all"           on public.rooms;
drop policy if exists "groomers admin all"        on public.groomers;
drop policy if exists "groomer_blocks admin all"  on public.groomer_blocks;
drop policy if exists "checkin_notes admin all"   on public.checkin_notes;
drop policy if exists "booking_edits admin all"   on public.booking_edits;

create policy "payments admin all"       on public.payments       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "rooms admin all"          on public.rooms          for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "groomers admin all"       on public.groomers       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "groomer_blocks admin all" on public.groomer_blocks for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "checkin_notes admin all"  on public.checkin_notes  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "booking_edits admin all"  on public.booking_edits  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- blocked_schedules: updates were allowed for any signed-in user (auth.role() = 'authenticated').
drop policy if exists "Authenticated users can update blocked_schedules" on public.blocked_schedules;
drop policy if exists "blocked_schedules update by admins"               on public.blocked_schedules;
create policy "blocked_schedules update by admins" on public.blocked_schedules
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Storage: the private vaccine-docs bucket (vaccine records, payment receipts) was downloadable by any
-- signed-in user. admin_read_vaccine_docs_storage already covers admins; customers get their own files
-- through the customer-account function.
drop policy if exists "Authenticated can read vaccine-docs"  on storage.objects;
drop policy if exists "authenticated_select_vaccine_docs"    on storage.objects;

notify pgrst, 'reload schema';
