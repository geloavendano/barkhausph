-- Ensure manual-transfer receipts are available to the admin drawer.
-- Safe to run even if 2026-06-15_payment_receipt.sql was already applied.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS receipt_path text;

COMMENT ON COLUMN public.payments.receipt_path IS
  'Storage path (vaccine-docs bucket) of the uploaded transfer receipt image, for manual online-transfer payments.';

-- The receipt upload currently reuses the private vaccine-docs bucket.
-- Create it if the project was restored without the bucket.
INSERT INTO storage.buckets (id, name, public)
VALUES ('vaccine-docs', 'vaccine-docs', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
