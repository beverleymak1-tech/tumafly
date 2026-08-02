-- Session 29 followup — drop dead M-Pesa index
--
-- idx_pending_bookings_mpesa_checkout indexed a column on the M-Pesa
-- payment path. Per 10.7 handoff §5, the M-Pesa button is disabled at
-- launch and the two M-Pesa EFs (create-mpesa-stk, mpesa-callback) are
-- not deployed pending updates for the 10.7 column rename. The index
-- therefore sits inert.
--
-- Dropping the index only, not the underlying column — the M-Pesa EFs
-- still reference the column and the future M-Pesa session will need
-- to fix + deploy them. Recreating the index at that point is a
-- one-line CREATE INDEX.
--
-- Applied against production via SQL Editor Aug 2 2026; this migration
-- file backfills for durability against fresh envs / re-provisions.
-- Idempotent (IF EXISTS guard) — safe no-op on any env where the index
-- is already absent.

DROP INDEX IF EXISTS public.idx_pending_bookings_mpesa_checkout;

NOTIFY pgrst, 'reload schema';
