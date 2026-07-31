-- Associate each reusable customer vaccine document with its vaccine type.
-- Existing documents remain valid with a NULL type and appear as legacy records
-- until the customer replaces or re-uploads them under a specific vaccine.

alter table public.pet_vaccine_documents
  add column if not exists vaccine_key text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pet_vaccine_documents_vaccine_key_check'
      and conrelid = 'public.pet_vaccine_documents'::regclass
  ) then
    alter table public.pet_vaccine_documents
      add constraint pet_vaccine_documents_vaccine_key_check
      check (vaccine_key is null or vaccine_key ~ '^[A-Za-z0-9_]{1,100}$');
  end if;
end
$$;

create index if not exists pet_vaccine_documents_pet_vaccine_active_idx
  on public.pet_vaccine_documents (pet_id, vaccine_key)
  where active = true;

comment on column public.pet_vaccine_documents.vaccine_key is
  'Vaccine declaration key this reusable document supports; NULL denotes a legacy unclassified document.';

notify pgrst, 'reload schema';
