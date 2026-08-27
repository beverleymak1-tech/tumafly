-- session_s39_heartbeat_infra.sql
--
-- Session 39 — heartbeat infrastructure.
--
-- Ships three things:
--   1. `heartbeat_runs` audit table — one row per heartbeat EF invocation.
--      Captures both what it found (stuck row / cron failure counts + full
--      contexts) and whether the healthchecks.io ping succeeded. Retained
--      indefinitely; low volume (24 rows/day).
--   2. `get_recent_http_failures()` SECURITY DEFINER function — bridges the
--      `net._http_response` table (which the service role can read but the
--      Supabase JS client can't easily reach in the `net` schema) into the
--      `public` schema so the heartbeat EF can call it via `.rpc()`.
--   3. `heartbeat_hourly` pg_cron job — invokes the heartbeat EF hourly.
--      Reads `service_role_key` from `vault.decrypted_secrets` at runtime,
--      following the same pattern as `retry-stuck-bookings` (jobid 1).
--
-- Applied via SQL Editor. This file commits the applied state to git for
-- repro / audit purposes, matching the `session_s09_retention_jobs.sql`
-- convention.
--
-- Motivation. Session 39 discovered retry-stuck-bookings cron had been
-- 401'ing continuously (probably months) because the vault entry for
-- `service_role_key` was a placeholder (`<SERVICE_ROLE_KEY>`, length 18)
-- that was never populated. Nothing was watching `net._http_response`
-- for non-200s from cron. This infrastructure lets a new `heartbeat` EF
-- check both:
--   Signal 1 — stuck rows in customer-money-taken non-terminal states
--   Signal 2 — cron auth health (non-2xx from any pg_net HTTP caller)
-- and ping healthchecks.io as an external liveness signal that catches
-- the case where the heartbeat itself can't run (which would otherwise
-- be the same class of silent failure this whole system is designed to
-- detect).
--
-- Related work in Session 39:
--   - Session 38's P0 (webhook secret drift) taught us silent auth
--     failures can hide for weeks. Session 39 found a second one that
--     had been hiding for months. Heartbeat is the systemic answer.
--   - Fix B (verify-payment `duffel_pending` enum addition) ships in the
--     same session but is unrelated (frontend state accuracy).
--   - Fix A (reconciler orphan-check redesign) deferred to Session 40 as
--     an architectural project, not a patch — see Session 39 handoff.
--
-- Rollback:
--   To fully undo this migration:
--     SELECT cron.unschedule('heartbeat_hourly');
--     DROP FUNCTION public.get_recent_http_failures(int);
--     DROP TABLE public.heartbeat_runs;
--   (Order matters — cron depends on nothing here, but the function &
--    table are independent.)

-- ── Section 1: audit table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.heartbeat_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stuck_row_count       INT NOT NULL DEFAULT 0,
  cron_failure_count    INT NOT NULL DEFAULT 0,
  healthchecks_ping_ok  BOOLEAN NOT NULL DEFAULT FALSE,
  stuck_rows_context    JSONB,
  cron_failures_context JSONB,
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS heartbeat_runs_ran_at_idx
  ON public.heartbeat_runs (ran_at DESC);

-- RLS enabled with no policies = deny-all for anon/authenticated.
-- Service role bypasses RLS by design. Matches the pattern used for
-- `alerts` table (see Session 35b Design Audit §2.1-3).
ALTER TABLE public.heartbeat_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.heartbeat_runs IS
  'Audit log of heartbeat EF invocations (Session 39). One row per hourly '
  'cron fire. Contexts contain the raw findings so a later human can '
  'reconstruct what triggered any alert. Retained indefinitely (low volume, '
  'high forensic value). RLS deny-all — service role only.';

-- ── Section 2: net._http_response bridge function ───────────────────────
-- `net._http_response` is populated by pg_net (the extension that pg_cron
-- uses to make outbound HTTP calls). Service role has access to the `net`
-- schema at the database level but the Supabase JS client's PostgREST
-- interface can't cleanly query non-public schemas without additional
-- configuration. SECURITY DEFINER function in `public` is the standard
-- workaround — same pattern as `sweep_orphan_pending_bookings()` in
-- `20260803120000_pg_cron_orphan_sweep.sql`.
CREATE OR REPLACE FUNCTION public.get_recent_http_failures(
  window_minutes INT DEFAULT 60
)
RETURNS TABLE (
  id          BIGINT,
  status_code INT,
  created     TIMESTAMPTZ,
  timed_out   BOOLEAN,
  error_msg   TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT id, status_code, created, timed_out, error_msg
  FROM net._http_response
  WHERE created > NOW() - (window_minutes || ' minutes')::INTERVAL
    AND (status_code >= 400 OR status_code IS NULL OR timed_out = TRUE OR error_msg IS NOT NULL)
  ORDER BY created DESC;
$$;

COMMENT ON FUNCTION public.get_recent_http_failures(int) IS
  'Session 39 heartbeat helper. Returns any pg_net HTTP responses in the '
  'trailing window that indicate failure (non-2xx status, null status, '
  'timeout, or explicit error). Used by the heartbeat EF (Signal 2). '
  'SECURITY DEFINER because the `net` schema is not accessible to the '
  'service role via the Supabase JS client without this bridge.';

REVOKE ALL ON FUNCTION public.get_recent_http_failures(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_recent_http_failures(int) TO service_role;

-- ── Section 3: pg_cron job ──────────────────────────────────────────────
-- Hourly invocation of the heartbeat EF. Follows the same auth pattern
-- as retry-stuck-bookings (jobid 1) — reads `service_role_key` from
-- `vault.decrypted_secrets` at runtime, so a future rotation of the
-- service role key requires only a vault update (not a cron edit).
--
-- Idempotent guard: if the job already exists (from a re-run of this
-- migration), unschedule first so cron.schedule doesn't error on
-- duplicate jobname. Matches the pattern in `20260803120000_pg_cron_
-- orphan_sweep.sql` §3.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'heartbeat_hourly') THEN
    PERFORM cron.unschedule('heartbeat_hourly');
  END IF;
END $$;

SELECT cron.schedule(
  'heartbeat_hourly',
  '0 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wmplcauhaqtyenwvkrkq.supabase.co/functions/v1/heartbeat',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cron$
);

-- ── Verification block ──────────────────────────────────────────────────
-- After applying this migration, run these to confirm:
--
--   -- 1. Table exists
--   SELECT COUNT(*) FROM public.heartbeat_runs;
--   -- Expected: 0 (will grow to 24/day after cron starts)
--
--   -- 2. Function exists and is callable
--   SELECT COUNT(*) FROM public.get_recent_http_failures(60);
--   -- Expected: integer >= 0. If cron auth is currently healthy across
--   -- all pg_net callers, expect 0.
--
--   -- 3. Cron job scheduled
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'heartbeat_hourly';
--   -- Expected: 1 row, schedule = '0 * * * *', active = true
--
--   -- 4. After the top of the next hour, one heartbeat_runs row should
--   -- appear. Confirm cron delivery:
--   SELECT status_code, created FROM public.get_recent_http_failures(120)
--   WHERE created > NOW() - INTERVAL '5 minutes';
--   -- Note: this only shows FAILURES. Success responses (200) do NOT
--   -- appear via this bridge. To see the successful cron fire, query
--   -- net._http_response directly OR check heartbeat_runs.