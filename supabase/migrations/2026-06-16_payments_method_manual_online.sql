-- Allow the manual upload flow to record a stable payment method while keeping
-- the transferred-to bank in payments.notes.

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_method_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_check
  CHECK (
    method IN (
      'cash',
      'card',
      'credit_debit_card',
      'bank_transfer',
      'online',
      'gcash',
      'gcash_qrph',
      'bpi',
      'bdo',
      'transfer',
      'manual_online'
    )
  );

NOTIFY pgrst, 'reload schema';
