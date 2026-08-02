-- Session 29 §3.4 — rename pesapal-era UNIQUE-constraint indexes
--
-- After 10.7 renamed the underlying columns (see 20260802100001), the
-- UNIQUE-constraint auto-generated index NAMES still read pesapal_*.
-- Postgres updated column references transparently on the RENAME COLUMN,
-- but the index name itself is metadata that only changes on explicit
-- ALTER INDEX. Any duplicate-key error message will leak the stale name
-- to logs / support tickets.
--
-- ALTER INDEX ... RENAME TO is metadata-only in Postgres — no lock beyond
-- the momentary catalog write. No downtime.
--
-- Idempotent via IF EXISTS. Applying twice against prod is safe (second
-- run: source index no longer exists, statement no-ops). Fresh envs will
-- run this after 20260802100001 has renamed the columns.

ALTER INDEX IF EXISTS public.pending_bookings_pesapal_order_id_key
  RENAME TO pending_bookings_merchant_ref_key;

ALTER INDEX IF EXISTS public.pending_bookings_pesapal_tracking_id_key
  RENAME TO pending_bookings_processor_transaction_id_key;

NOTIFY pgrst, 'reload schema';
