-- Session 29 §3.5 — nightly pg_cron sweep for orphan pending_bookings
--
-- Root causes of orphans:
--   1. User abandons checkout after initialize-payment fires (row stays
--      status='pending' forever)
--   2. Session 28e-10.1 snapshot-invalidation cascade — every traveler edit
--      fires fresh initialize-payment, creating new pending row and
--      orphaning the previous one immediately
--
-- Rows that stayed status='pending' beyond 48h cannot have downstream FK
-- references (bookings.pending_booking_id and refunds.pending_booking_id
-- both require the pending to have transitioned to 'paid' first). Safe to
-- DELETE without cascade risk.
--
-- 48h chosen because Paystack transactions can take up to 24h to fully
-- settle. 48h gives a comfortable margin against deleting rows that might
-- yet transition.
--
-- Runs nightly at 03:00 UTC (Nairobi 06:00 — well before customers wake).
--
-- Applied against production via SQL Editor Aug 3, 2026. Initial manual
-- sweep on same date cleared 199 backlogged orphans. This migration file
-- backfills for durability against fresh envs / re-provisions.
-- Idempotent — safe to re-run: CREATE EXTENSION uses IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION overwrites, and the cron.schedule call is
-- protected against duplicate jobname (see verification below).

-- 1. Ensure pg_cron is enabled (Supabase includes it by default on Free tier)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. The sweep function — SECURITY DEFINER runs as the function owner
--    (postgres), bypassing RLS. Logs the count to Postgres logs so we can
--    monitor orphan volume over time.
CREATE OR REPLACE FUNCTION public.sweep_orphan_pending_bookings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.pending_bookings
  WHERE status = 'pending'
    AND created_at < now() - interval '48 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE '[sweep_orphan_pending_bookings] deleted % rows', deleted_count;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_orphan_pending_bookings() FROM PUBLIC;

-- 3. Schedule via pg_cron — nightly at 03:00 UTC
--    Guard against duplicate: unschedule any existing job with the same
--    name first, then re-schedule. This makes the migration idempotent
--    on re-runs (which the existing cron.schedule call is not by default).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep_orphan_pending_bookings_nightly') THEN
    PERFORM cron.unschedule('sweep_orphan_pending_bookings_nightly');
  END IF;
END $$;

SELECT cron.schedule(
  'sweep_orphan_pending_bookings_nightly',
  '0 3 * * *',
  $$SELECT public.sweep_orphan_pending_bookings();$$
);

-- To verify after applying:
--   SELECT * FROM cron.job WHERE jobname = 'sweep_orphan_pending_bookings_nightly';
--   -- Should show one row with schedule '0 3 * * *' and active=true
--
-- To manually invoke for testing:
--   SELECT public.sweep_orphan_pending_bookings();
--   -- Returns deleted row count (0 in steady state; higher if backlog grew)
