-- supabase/migrations/session_s46_s17_synthetic_cron.sql
--
-- S-17 Phase 5d: pg_cron schedule for health-check-synthetic EF.
--
-- ─── A3-ONLY (VAULT-GATED) ────────────────────────────────────────────────
-- Schedules the synthetic probe cron ONLY if vault entry TUMAFLY_ENV equals
-- 'a3-sandbox'. On prod (TUMAFLY_ENV absent or set to anything else), this
-- migration no-ops with a RAISE NOTICE and does NOT create the cron job.
--
-- Belt + suspenders defense (3 layers):
--   1. This vault gate (migration-level, primary defense)
--   2. health-check-synthetic EF runtime-refuses if SUPABASE_URL !~ A3 ref
--   3. .github/workflows/deploy-prod.yml excludes the EF from prod deploy
--
-- ─── PRE-REQS (ONE-TIME PER ENVIRONMENT) ──────────────────────────────────
-- On A3 Supabase SQL editor, run ONCE:
--   SELECT vault.create_secret('a3-sandbox', 'TUMAFLY_ENV');
-- On prod Supabase SQL editor, OPTIONAL (makes the no-op explicit):
--   SELECT vault.create_secret('production', 'TUMAFLY_ENV');
--
-- Also required (already in place from Session 39 heartbeat crons):
--   vault entry 'service_role_key' with the A3 service_role JWT.
--   Confirm with: SELECT name FROM vault.decrypted_secrets WHERE name IN ('TUMAFLY_ENV', 'service_role_key');
--
-- ─── WHAT IT DOES ─────────────────────────────────────────────────────────
-- Every 5 min, pg_cron calls:
--   POST https://nljxqcrmmkodbzsrzdba.supabase.co/functions/v1/health-check-synthetic
--     Headers: Authorization: Bearer <vault.SERVICE_ROLE_KEY>
--              Content-Type:  application/json
--     Body:    {"mode":"cron"}
--     Timeout: 30s
--
-- The EF probes 5 target EFs in parallel, fires SYNTHETIC_HEALTH_CHECK_FAILED
-- alerts for any failures (15-min dedup per EF). HEARTBEAT_CRON_FAILURES
-- (Session 39) monitors net._http_response — if the cron ITSELF fails
-- (401, 5xx from health-check-synthetic, timeout), that heartbeat catches it.
--
-- ─── IDEMPOTENCY ──────────────────────────────────────────────────────────
-- Unschedules any pre-existing job of the same name before re-scheduling,
-- so this migration is safe to re-apply on A3 after branch rebuilds or
-- `supabase db reset`.
--
-- ─── RELATED FILES ────────────────────────────────────────────────────────
-- supabase/functions/health-check-synthetic/index.ts  (the probe EF)
-- supabase/functions/alert-founder/index.ts            (SYNTHETIC_HEALTH_CHECK_FAILED)
-- .github/workflows/deploy-prod.yml                    (prod exclusion)
-- RUNBOOK §YY                                           (S-17 architecture)

DO $$
DECLARE
  v_env text;
BEGIN
  -- Read TUMAFLY_ENV from vault. If missing or not 'a3-sandbox', no-op.
  SELECT decrypted_secret INTO v_env
  FROM vault.decrypted_secrets
  WHERE name = 'TUMAFLY_ENV'
  LIMIT 1;

  IF v_env IS NULL THEN
    RAISE NOTICE '[s17 phase 5d] vault.TUMAFLY_ENV missing — skipping synthetic health-check cron. On A3 run: SELECT vault.create_secret(''a3-sandbox'', ''TUMAFLY_ENV'');';
    RETURN;
  END IF;

  IF v_env <> 'a3-sandbox' THEN
    RAISE NOTICE '[s17 phase 5d] vault.TUMAFLY_ENV = % (not a3-sandbox) — skipping synthetic health-check cron', v_env;
    RETURN;
  END IF;

  -- Idempotent: unschedule any prior version of this job before re-scheduling.
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 's17-synthetic-health-check';

  -- Schedule: every 5 min, invoke health-check-synthetic with {"mode":"cron"}.
  -- Auth via vault.SERVICE_ROLE_KEY (same convention as Session 39 crons).
  PERFORM cron.schedule(
    's17-synthetic-health-check',
    '*/5 * * * *',
    $cron_body$
    SELECT net.http_post(
      url := 'https://nljxqcrmmkodbzsrzdba.supabase.co/functions/v1/health-check-synthetic',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'service_role_key'
          LIMIT 1
        ),
        'Content-Type', 'application/json'
      ),
      body := '{"mode":"cron"}'::jsonb,
      timeout_milliseconds := 30000
    );
    $cron_body$
  );

  RAISE NOTICE '[s17 phase 5d] scheduled s17-synthetic-health-check (*/5 * * * *) on A3';
END $$;