-- Read-only checks to run against PRODUCTION right before the orders release.
-- Runbook: docs/decisions/2026-10-26-release-night-runbook.md
-- Nothing here writes: the session is forced read-only, so a typo can't change data.
set default_transaction_read_only = on;
\pset pager off

\echo '== 1. Unique rules on payments.reference_number (the second migration drops the table-wide one BY NAME)'
\echo '   Expect the table-wide rule to be named payments_reference_number_unique or payments_reference_number_key.'
\echo '   Any OTHER name here means the migration will not drop it and 2-item orders will lose a payment row: STOP.'
select conname as constraint_name, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.payments'::regclass and contype in ('u', 'p');
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'payments' and indexdef ilike '%reference_number%';

\echo '== 2. Rows that would block the new per-booking unique index (expect 0 rows)'
select reference_number, booking_id, count(*) as copies
from public.payments
where reference_number is not null
group by 1, 2
having count(*) > 1;

\echo '== 3. Checkouts in flight right now (deploy when this is 0, or wait for them to expire)'
select ref_number, payment_provider, expires_at
from public.pending_bookings
where expires_at > now()
order by expires_at;

\echo '== 4. Things the orders migration relies on (expect: is_admin t, trigger t, booking_orders absent)'
select
  to_regprocedure('public.is_admin()') is not null                                   as is_admin_exists,
  exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = 'public.bookings'::regclass and p.proname = 'generate_ref_number') as ref_trigger_exists,
  to_regclass('public.booking_orders') is not null                                   as booking_orders_already_exists;

\echo '== 5. Row counts (compare with the same query after the release; nothing should shrink)'
select 'bookings' as tbl, count(*) from public.bookings
union all select 'payments', count(*) from public.payments
union all select 'pending_bookings', count(*) from public.pending_bookings
union all select 'owners', count(*) from public.owners
union all select 'pets', count(*) from public.pets
union all select 'customer_accounts', count(*) from public.customer_accounts
order by 1;
