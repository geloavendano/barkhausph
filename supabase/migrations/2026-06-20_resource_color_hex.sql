-- Replace the original fixed resource-color palette constraint with generic hex
-- validation. The admin UI still offers a curated palette, but future additions no
-- longer require a database constraint change.

DO $$
DECLARE
  target_table text;
  constraint_row record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['rooms', 'groomers', 'studios'] LOOP
    FOR constraint_row IN
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'c'
        AND conrelid = format('public.%I', target_table)::regclass
        AND pg_get_constraintdef(oid) ~* '\mcolor\M'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target_table, constraint_row.conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (color ~ ''^#[0-9A-Fa-f]{6}$'')',
      target_table,
      target_table || '_color_hex_check'
    );
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
