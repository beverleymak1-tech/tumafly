-- Session 29 §3.4 — backfill 10.7 column renames for durability
--
-- Session 28e-10.7 renamed four columns from pesapal_* to processor-agnostic
-- names and dropped two redundant indexes. The SQL was applied directly via
-- SQL Editor and never versioned as a migration file. Every payment EF now
-- references the new column names, so a fresh env / restore / db reset built
-- from these migrations would immediately break with "column does not exist"
-- errors on any payment path.
--
-- This migration backfills the 10.7 operations. It is:
--   - Idempotent — every statement guarded by IF EXISTS / IF NOT EXISTS
--   - A no-op against production (the renames already landed via SQL Editor)
--   - Required for fresh envs / re-provisions to reach parity
--
-- Ordering: must land before 20260802100002 (pesapal UNIQUE-index rename),
-- because that migration renames indexes whose underlying columns must
-- already be under their new names.

DO $$
BEGIN
  -- pending_bookings.pesapal_order_id → merchant_ref
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pending_bookings'
      AND column_name = 'pesapal_order_id'
  ) THEN
    ALTER TABLE public.pending_bookings RENAME COLUMN pesapal_order_id TO merchant_ref;
  END IF;

  -- pending_bookings.pesapal_tracking_id → processor_transaction_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pending_bookings'
      AND column_name = 'pesapal_tracking_id'
  ) THEN
    ALTER TABLE public.pending_bookings RENAME COLUMN pesapal_tracking_id TO processor_transaction_id;
  END IF;

  -- bookings.pesapal_tracking_id → processor_transaction_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bookings'
      AND column_name = 'pesapal_tracking_id'
  ) THEN
    ALTER TABLE public.bookings RENAME COLUMN pesapal_tracking_id TO processor_transaction_id;
  END IF;

  -- bookings.pesapal_confirmation_code → processor_authorization_code
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bookings'
      AND column_name = 'pesapal_confirmation_code'
  ) THEN
    ALTER TABLE public.bookings RENAME COLUMN pesapal_confirmation_code TO processor_authorization_code;
  END IF;
END $$;

-- Redundant indexes dropped during 10.7 (dupes of UNIQUE constraint auto-indexes)
DROP INDEX IF EXISTS public.idx_pending_bookings_order;
DROP INDEX IF EXISTS public.idx_pending_bookings_tracking;

NOTIFY pgrst, 'reload schema';
