-- Keep new resources at the end of their branch/type list even when inserted outside
-- the admin UI. Existing NULL orders are backfilled after all currently ordered rows.

CREATE OR REPLACE FUNCTION public.assign_resource_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.sort_order IS NULL THEN
    EXECUTE format(
      'SELECT coalesce(max(sort_order), -1) + 1 FROM public.%I WHERE branch_id = $1',
      TG_TABLE_NAME
    ) INTO NEW.sort_order USING NEW.branch_id;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['rooms', 'groomers', 'studios'] LOOP
    EXECUTE format(
      'WITH branch_max AS (
         SELECT branch_id, coalesce(max(sort_order), -1) AS max_order
         FROM public.%I GROUP BY branch_id
       ), ranked AS (
         SELECT r.id, bm.max_order + row_number() OVER (
           PARTITION BY r.branch_id ORDER BY r.name, r.id
         ) AS new_order
         FROM public.%I r
         JOIN branch_max bm USING (branch_id)
         WHERE r.sort_order IS NULL
       )
       UPDATE public.%I target SET sort_order = ranked.new_order
       FROM ranked WHERE target.id = ranked.id',
      target_table, target_table, target_table
    );

    EXECUTE format('DROP TRIGGER IF EXISTS set_%I_sort_order ON public.%I', target_table, target_table);
    EXECUTE format(
      'CREATE TRIGGER set_%I_sort_order BEFORE INSERT ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.assign_resource_sort_order()',
      target_table, target_table
    );
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
