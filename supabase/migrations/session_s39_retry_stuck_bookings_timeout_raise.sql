-- session_s39_retry_stuck_bookings_timeout_raise.sql
--
-- Session 39 — raise pg_net timeout on the retry-stuck-bookings cron
-- from the default 5s to 30s.
--
-- Applied via SQL Editor. This file commits the applied state to git
-- per the session_sXX convention (see session_s09_retention_jobs.sql
-- for the pattern).
--
-- Context. Session 39 shipped the heartbeat monitoring stack. Its
-- Signal 2 (cron auth failures) fired several alert emails within
-- 24 hours of deployment for retry-stuck-bookings pg_net timeouts:
--
--   4 timeouts across ~24h (08:45, 09:00, 11:20, 12:00 UTC on 2026-09-04)
--   All confirmed as retry-stuck-bookings (jobid 1) via audit-row
--   cross-reference (heartbeat_runs completed on every hour — so the
--   timeouts weren't heartbeat overlap noise).
--   Rate: ~0.28% of 1,440 daily fires. Low but non-zero.
--   Pattern: DNS resolves fast (1-4ms), HTTP takes the full 5s ceiling.
--
-- Root cause. Post-vault-fix (Session 39 P0), retry-stuck-bookings
-- actually runs the handler body for the first time in months.
-- Handler body includes Duffel API calls (the buggy orphan-check
-- `GET /air/orders` — same code the Duffel-webhook redesign will
-- eventually delete). Duffel's own docs advise HTTP client timeout
-- ≥130s because their airline backends can be slow. 5s ceiling is
-- too aggressive for this class of work.
--
-- 30s chosen because:
--   - Well below Duffel's 130s advisory but comfortable for typical
--     slow-API responses
--   - Doesn't mask genuine hangs — 30s is still "something wrong"
--     territory if hit often
--   - Reconciler work is idempotent — slow-but-completing runs are fine
--   - Aligns pg_net's patience with what the underlying work needs
--
-- Alternative considered + rejected: raise heartbeat's ceiling too.
-- Rejected because heartbeat has completed every hour without timeout
-- (verified via heartbeat_runs table 24h before this migration).
-- Heartbeat's typical latency is <2s. Don't need the raise.
--
-- Rollback: if 30s masks a real regression, re-run cron.unschedule +
-- cron.schedule without timeout_milliseconds parameter to return to
-- the 5s default.
--
-- Idempotent via cron.unschedule guard.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-stuck-bookings') THEN
    PERFORM cron.unschedule('retry-stuck-bookings');
  END IF;
END $$;

SELECT cron.schedule(
  'retry-stuck-bookings',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wmplcauhaqtyenwvkrkq.supabase.co/functions/v1/retry-stuck-bookings',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $cron$
);

-- Verify after applying:
--   SELECT jobid, jobname, schedule, active, command
--   FROM cron.job WHERE jobname = 'retry-stuck-bookings';
--   Expected: 1 row, schedule '* * * * *', active true, command contains
--   'timeout_milliseconds := 30000'.
--
-- Watch for timeout suppression after apply:
--   SELECT count(*) FROM net._http_response
--   WHERE created > NOW() - INTERVAL '4 hours' AND timed_out = true;
--   Expected: no NEW timeouts in the window post-apply (old ones may
--   still show in the tail of the window).