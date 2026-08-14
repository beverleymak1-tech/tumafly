-- Session S-07c-alerts: dedup + audit framework for alert-founder.
-- Extends existing public.alerts table (78 rows preserved).
-- Adds: dedup_key, suppressed, suppression_reason, dedup lookup index,
-- 365-day retention cron.

BEGIN;

ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS dedup_key           text,
  ADD COLUMN IF NOT EXISTS suppressed          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suppression_reason  text;

CREATE INDEX IF NOT EXISTS alerts_dedup_lookup_idx
  ON public.alerts (alert_type, dedup_key, created_at DESC)
  WHERE dedup_key IS NOT NULL;

COMMIT;

-- 365-day retention (KYC 2.6 aligned; tunable in S-09 retention pass)
SELECT cron.schedule(
  'alerts_retention_365d',
  '0 4 * * *',
  $$DELETE FROM public.alerts WHERE created_at < now() - interval '365 days'$$
);
