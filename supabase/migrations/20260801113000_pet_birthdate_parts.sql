-- Store a customer pet's birth month/year, with an optional day.
-- age_value and age_unit remain populated as derived compatibility fields for
-- the existing booking and admin experiences.

-- Compatibility repair: the customer-account function already reads this
-- column. Keep this migration safe for projects where the earlier vaccine-type
-- migration was not applied or only partially applied.
alter table public.pet_vaccine_documents
  add column if not exists vaccine_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pet_vaccine_documents_vaccine_key_check'
      and conrelid = 'public.pet_vaccine_documents'::regclass
  ) then
    alter table public.pet_vaccine_documents
      add constraint pet_vaccine_documents_vaccine_key_check
      check (vaccine_key is null or vaccine_key ~ '^[A-Za-z0-9_]{1,100}$');
  end if;
end $$;

create index if not exists pet_vaccine_documents_pet_vaccine_active_idx
  on public.pet_vaccine_documents (pet_id, vaccine_key)
  where active = true;

comment on column public.pet_vaccine_documents.vaccine_key is
  'Vaccine declaration key this reusable document supports; NULL denotes a legacy unclassified document.';

alter table public.pets
  add column if not exists birth_year smallint,
  add column if not exists birth_month smallint,
  add column if not exists birth_day smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pets_birth_year_range'
  ) then
    alter table public.pets
      add constraint pets_birth_year_range
      check (birth_year is null or birth_year between 1900 and 2200);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pets_birth_month_range'
  ) then
    alter table public.pets
      add constraint pets_birth_month_range
      check (birth_month is null or birth_month between 1 and 12);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pets_birth_day_range'
  ) then
    alter table public.pets
      add constraint pets_birth_day_range
      check (birth_day is null or birth_day between 1 and 31);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pets_birth_month_year_pair'
  ) then
    alter table public.pets
      add constraint pets_birth_month_year_pair
      check ((birth_year is null) = (birth_month is null));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pets_birth_day_has_month_year'
  ) then
    alter table public.pets
      add constraint pets_birth_day_has_month_year
      check (birth_day is null or (birth_year is not null and birth_month is not null));
  end if;
end $$;

comment on column public.pets.birth_year is 'Customer-entered pet birth year; required by the customer account API for new/edited pets.';
comment on column public.pets.birth_month is 'Customer-entered pet birth month (1-12); required by the customer account API for new/edited pets.';
comment on column public.pets.birth_day is 'Optional customer-entered pet birth day.';

notify pgrst, 'reload schema';
