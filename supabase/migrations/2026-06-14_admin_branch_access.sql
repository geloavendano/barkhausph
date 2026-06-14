-- Per-account branch access for the admin dashboard.
--
-- admin_users.branch_ids lists the branches an account may view across all tabs
-- (Calendar, Bookings, Check-In, Inventory). NULL or an empty array = ALL branches,
-- so existing admins are unaffected until explicitly restricted.
--
-- Enforcement is UI-level: App.jsx filters the branch list (and the branch switcher)
-- to this set. Member-code validation stays global regardless of this restriction.

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS branch_ids uuid[];

COMMENT ON COLUMN public.admin_users.branch_ids IS
  'Branches this admin may access in the dashboard. NULL/empty = all branches.';

-- ── Usage examples (run as needed) ─────────────────────────────────────────
-- Find branch IDs:
--   SELECT id, name FROM public.branches ORDER BY created_at;
--
-- Restrict an account to a single branch (e.g. Eastwood only):
--   UPDATE public.admin_users
--     SET branch_ids = ARRAY['<eastwood-uuid>']::uuid[]
--     WHERE email = 'eastwood.staff@example.com';
--
-- Give an account both branches explicitly (identical to leaving it NULL):
--   UPDATE public.admin_users SET branch_ids = NULL
--     WHERE email = 'manager@example.com';
