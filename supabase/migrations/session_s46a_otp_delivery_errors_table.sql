-- Session 46.a — otp_delivery_errors table (side-channel for Supabase Auth hook)
-- ============================================================================
-- Purpose: Supabase Auth action hooks (send_sms, send_email) hardcode-mask
-- hook response bodies with generic strings ("Service currently unavailable
-- due to hook", "Unexpected status code returned from hook: 500"), regardless
-- of whether the hook returns the documented {error: {http_code, message}}
-- schema. This is architectural in gotrue, not fixable from the EF.
--
-- Discovered: Session 46.a (2026-10-07) during Phase D throttle smoke on A3.
-- Our migration from silent HTTP 200 {} to structured errors (throttle 429,
-- AT failure 502, outer catch 500) correctly surfaces failures to gotrue,
-- but gotrue swallows the structured body and shows generic strings.
--
-- Fix: side-channel pattern. send-otp writes a row to this table on failure
-- paths where phone is reliably available (#4, #5, #6, #7 per handoff §... --
-- see Session 46.a close bundle). Frontend intercepts gotrue's generic mask
-- strings in signInWithOtp() catch block, queries this table by phone, and
-- displays the row's user_message. If no row exists, falls back to a unified
-- "Something went wrong sending your code. Please try again, or use another
-- sign-in option." string.
--
-- Access model:
--   service_role: FOR ALL (send-otp writes via upsert; no reads needed from
--                 EF side). Explicit policy per Session 44 lesson —
--                 ENABLE RLS without policy = silent write failure.
--   anon:         FOR SELECT (frontend queries by phone during signin flow;
--                 user is not yet authenticated at throttle-check time).
--                 Low-sensitivity data (phone + retry timing + reason + message)
--                 — anyone with the anon key can list all throttled phones,
--                 but the enumeration surface is low-value and matches
--                 otp_attempts' existing public-ish exposure. Session 50
--                 migrates both tables' scope/phone columns to SHA256 which
--                 moots this enumeration concern.
--
-- Phone format: plaintext (consistent with otp_attempts). Supabase Auth
-- strips the "+" prefix before passing payloads to hooks; EF stores the
-- no-plus form. Session 50 migrates both tables to SHA256-hashed phone atomically.
--
-- Retention: cron sweep every 15 min removes rows whose retry_available_at
-- window ended >1 hour ago (gives frontend reasonable grace for stale queries).
--
-- Related: send-otp v3 patch (upserts into this table), frontend
-- signInWithOtp() catch block (queries this table on gotrue mask detection),
-- Session 50 docket item (migrate scope_value / phone_number to SHA256).

BEGIN;

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.otp_delivery_errors (
  phone_number       text        PRIMARY KEY,
  retry_available_at timestamptz,
  last_reason        text        NOT NULL,
  user_message       text        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.otp_delivery_errors IS
  'Side-channel for OTP send-otp hook failures (Session 46.a). gotrue action-hook body-masking workaround.';
COMMENT ON COLUMN public.otp_delivery_errors.phone_number       IS
  'Plaintext phone (no-plus prefix, as passed by Supabase Auth). Session 50 migrates to SHA256.';
COMMENT ON COLUMN public.otp_delivery_errors.retry_available_at IS
  'When throttle window ends. NULL for non-throttle failures.';
COMMENT ON COLUMN public.otp_delivery_errors.last_reason        IS
  'Enum: throttled_15m | throttled_24h | at_delivery_failed | at_recipient_failed';
COMMENT ON COLUMN public.otp_delivery_errors.user_message       IS
  'Exact string for frontend to display. Written by send-otp, read by anon frontend query.';

CREATE INDEX IF NOT EXISTS idx_otp_delivery_errors_updated_at
  ON public.otp_delivery_errors (updated_at);

-- Index for retention cron scan efficiency
CREATE INDEX IF NOT EXISTS idx_otp_delivery_errors_retry_available_at
  ON public.otp_delivery_errors (retry_available_at)
  WHERE retry_available_at IS NOT NULL;

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.otp_delivery_errors ENABLE ROW LEVEL SECURITY;

-- service_role: FOR ALL (send-otp upserts). Explicit per Session 44 lesson.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'otp_delivery_errors'
      AND policyname = 'service_role_all_otp_delivery_errors'
  ) THEN
    CREATE POLICY "service_role_all_otp_delivery_errors"
      ON public.otp_delivery_errors
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- anon: FOR SELECT (frontend queries during signin flow, user not yet JWT'd).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'otp_delivery_errors'
      AND policyname = 'anon_select_otp_delivery_errors'
  ) THEN
    CREATE POLICY "anon_select_otp_delivery_errors"
      ON public.otp_delivery_errors
      FOR SELECT
      TO anon
      USING (true);
  END IF;
END $$;

-- ─── Retention cron ─────────────────────────────────────────────────────────
-- Every 15 min: drop rows whose retry window ended >1 hour ago.
-- Non-throttle rows (retry_available_at IS NULL) are swept on updated_at age.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'otp_delivery_errors_cleanup') THEN
    PERFORM cron.schedule(
      'otp_delivery_errors_cleanup',
      '*/15 * * * *',
      $query$
      DELETE FROM public.otp_delivery_errors
      WHERE (retry_available_at IS NOT NULL AND retry_available_at < now() - interval '1 hour')
         OR (retry_available_at IS NULL     AND updated_at         < now() - interval '1 hour');
      $query$
    );
  END IF;
END $$;

COMMIT;

-- Verify after apply:
--   SELECT policyname, cmd, roles FROM pg_policies
--     WHERE schemaname = 'public' AND tablename = 'otp_delivery_errors';
--   Expected: 2 rows (service_role_all_*, anon_select_*).
--
--   SELECT jobid, jobname, schedule FROM cron.job
--     WHERE jobname = 'otp_delivery_errors_cleanup';
--   Expected: 1 row with schedule '*/15 * * * *'.
