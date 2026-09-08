-- Session 40 · Raise heartbeat_hourly cron's pg_net timeout from default 5s to 30s.
--
-- Context: heartbeat_hourly was scheduled at Session 39 without an explicit
-- timeout_milliseconds param on the net.http_post call, defaulting to 5000 ms.
-- Between 2026-09-07 03:00 UTC and 2026-09-08 06:00 UTC, 7 alerts fired for
-- HEARTBEAT_CRON_FAILURES — all from heartbeat's own cron→EF invocation
-- timing out at exactly 5000 ms on the hour boundary.
--
-- Investigation (Session 40, 2026-09-08):
-- - EF completed successfully on every one of those hours (heartbeat_runs shows
--   healthchecks_ping_ok: true for all 7 windows) — pg_net closed the socket
--   from OUR side at 5s, but the EF continued to run to completion on Supabase's
--   side and wrote its audit row + pinged healthchecks.io before pg_net's
--   timeout was recorded.
-- - Direct curl measurements from a nearby machine: cold call 2.2s, warm call
--   1.68s. Steady-state EF work is ~1.5-2s; hourly-scheduled cron fires from
--   Supabase's internal cron infrastructure have zero locality guarantee and
--   variance can tip past the 5s ceiling, producing false-positive alerts.
-- - 2 of the 7 failures were pure DNS-time timeouts (rare transient DNS glitches
--   in Supabase's edge infra); the other 5 were HTTP-phase timeouts consistent
--   with EF response time + cron-infra network jitter.
--
-- Fix: raise to 30000 ms, matching retry-stuck-bookings (Session 39 timeout raise).
-- At 30s, warm/cold EF variation is nowhere near the ceiling, and real DNS or
-- edge outages >30s will still surface as genuine signal via Signal 2.
--
-- Note: jobid will change on unschedule+reschedule (heartbeat_hourly was 7; will
-- become higher). Diagnostic queries should reference jobname, not jobid.
--
-- Applied via Supabase SQL Editor on 2026-09-08.

SELECT cron.unschedule('heartbeat_hourly');

SELECT cron.schedule(
  'heartbeat_hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wmplcauhaqtyenwvkrkq.supabase.co/functions/v1/heartbeat',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);

-- Verify the reschedule landed with the new command including timeout_milliseconds
SELECT jobid, jobname, schedule, active,
       CASE
         WHEN command LIKE '%timeout_milliseconds := 30000%' THEN '✅ 30s timeout set'
         ELSE '❌ command missing timeout_milliseconds — investigate'
       END AS timeout_check
FROM cron.job
WHERE jobname = 'heartbeat_hourly';