-- Manual bank/e-wallet transfer payments (interim, while PayMongo is archived).
-- The online booking flow now records the customer's transfer as a payments row
-- with the chosen bank in `method` (gcash/bpi/bdo) and the uploaded receipt image
-- path in this new column. The receipt lives in the existing private `vaccine-docs`
-- storage bucket; the admin drawer renders it via a short-lived signed URL.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS receipt_path text;

COMMENT ON COLUMN public.payments.receipt_path IS
  'Storage path (vaccine-docs bucket) of the uploaded transfer receipt image, for manual online-transfer payments.';
