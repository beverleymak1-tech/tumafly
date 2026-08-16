-- session_s09_rtbf_functions.sql
--
-- Session 35c: RTBF Stage 4 as a Postgres function (not application code).
-- Founder decision at Session 35b close: runs inside the DB where data lives,
-- idempotent by design, callable from SOP §3 with a single SQL statement,
-- auditable via pg_stat_statements.
--
-- Architecture B three-era state model (see TumaFly_Session35b_Design_Audit.md §2.6):
--   era1_pre_redaction    | created_at < 2026-08-13 08:22:48+00 | raw PII, must anonymize
--   era2_over_redacted    | 2026-08-13 08:22:48+00 to 2026-08-14 17:54:00+00 | PII stored as "[REDACTED]" literal; anonymization is idempotent no-op
--   era3_architecture_b   | created_at >= 2026-08-14 17:54:00+00 | raw PII (Arch B preserved), must anonymize
--
-- PII_KEYS mirror MUST stay in sync with _shared/redact.ts PII_KEYS.
-- Currently 24 keys. Any change to redact.ts PII_KEYS requires a matching
-- migration here. See RUNBOOK Alerts Redaction Matrix section.
--
-- Scrub semantic (design call Session 35c):
--   If a matched row contains multiple data subjects' PII (e.g., booker email
--   + passenger names for a family booking), ALL PII in that row is scrubbed
--   when triggered by any one subject. Rationale: matches "erase what I gave
--   you" intent + DPA §40 is silent on multi-subject rows + subsequent RTBF
--   from a secondary passenger still works (function doesn't require
--   identifier match on second run). Documented in SOP §3.
--
-- Row-match semantic:
--   Prefilter uses POSITION('"' || subject || '"' IN context::text) to match
--   quote-delimited JSON string values. Avoids LIKE-metacharacter escaping
--   AND avoids "bev@x.com" matching "bev@x.commerce.io" false positives.
--
-- Schema invariants (verified Session 35c via information_schema.columns):
--   alerts table columns: id, alert_type, severity, context, sent_to, email_id,
--   email_status, resolved, resolved_at, created_at, dedup_key, suppressed,
--   suppression_reason.
--   NOT NULL columns without default: alert_type, severity, context, sent_to.
--   NO subject/body columns — those are rendered from ALERT_CONFIG at
--   alert-founder email dispatch time.
--
-- Self-audit convention:
--   sent_to='audit-only:rtbf' is a sentinel indicating this row was inserted
--   directly by DB code, never dispatched via alert-founder → Resend. The
--   convention 'audit-only:<subsystem>' is reserved for all future DB-triggered
--   self-audit rows (audit_log Ops-1, cron success logs, etc.). See RUNBOOK
--   for the general pattern.
--   alert-founder ignores alert_types not in ALERT_CONFIG, so RTBF_EXECUTED
--   never generates an email regardless of sent_to value.

-- ── Recursive walk helper ────────────────────────────────────────────────
-- Immutable: same input always produces same output. No table access, no
-- time-varying dependencies.

CREATE OR REPLACE FUNCTION public.rtbf_walk_jsonb(
  p_input jsonb,
  p_marker text
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_output jsonb;
  v_key text;
  v_val jsonb;
  v_pii_keys text[] := ARRAY[
    'email', 'phone', 'phone_number',
    'contact_email', 'contact_phone',
    'customer_email', 'customer_phone',
    'given_name', 'family_name', 'middle_name',
    'first_name', 'last_name', 'full_name',
    'passenger_name', 'customer_name',
    'passport_number', 'passport_no',
    'unique_identifier',
    'account_number',
    'expires_on',
    'issuing_country_code',
    'nationality', 'gender',
    'born_on', 'dob', 'date_of_birth', 'birthdate'
  ];
BEGIN
  IF p_input IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_input) = 'array' THEN
    RETURN COALESCE(
      (SELECT jsonb_agg(public.rtbf_walk_jsonb(elem, p_marker))
       FROM jsonb_array_elements(p_input) AS elem),
      '[]'::jsonb
    );
  END IF;

  IF jsonb_typeof(p_input) = 'object' THEN
    v_output := '{}'::jsonb;
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_input) LOOP
      IF LOWER(v_key) = ANY(v_pii_keys) THEN
        v_output := v_output || jsonb_build_object(v_key, to_jsonb(p_marker));
      ELSIF jsonb_typeof(v_val) IN ('object', 'array') THEN
        v_output := v_output || jsonb_build_object(v_key, public.rtbf_walk_jsonb(v_val, p_marker));
      ELSE
        v_output := v_output || jsonb_build_object(v_key, v_val);
      END IF;
    END LOOP;
    RETURN v_output;
  END IF;

  RETURN p_input;
END $$;

COMMENT ON FUNCTION public.rtbf_walk_jsonb(jsonb, text) IS
  'RTBF helper: recursively walks jsonb, replacing values under PII keys with marker. Immutable. PII_KEYS mirror of _shared/redact.ts — sync required on any change.';


-- ── Main RTBF anonymize function ─────────────────────────────────────────
-- SECURITY DEFINER: runs as function owner (postgres role) so it can bypass
-- RLS on the alerts table. Callers need EXECUTE grant on the function
-- itself but do NOT need direct alerts access.

CREATE OR REPLACE FUNCTION public.rtbf_anonymize_alerts_context(
  p_subject_email text,
  p_subject_phone text,
  p_ticket_ref text,
  p_actor text
) RETURNS TABLE (
  rows_matched    int,
  rows_anonymized int,
  eras_touched    text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_matched    int := 0;
  v_anonymized int := 0;
  v_eras       text[] := ARRAY[]::text[];
  v_marker     text;
  v_row        record;
  v_new_ctx    jsonb;
  v_era        text;
  v_era1_end   timestamptz := '2026-08-13 08:22:48+00';
  v_era2_end   timestamptz := '2026-08-14 17:54:00+00';
BEGIN
  p_subject_email := NULLIF(TRIM(p_subject_email), '');
  p_subject_phone := NULLIF(TRIM(p_subject_phone), '');
  p_ticket_ref    := NULLIF(TRIM(p_ticket_ref), '');
  p_actor         := NULLIF(TRIM(p_actor), '');

  IF p_subject_email IS NULL AND p_subject_phone IS NULL THEN
    RAISE EXCEPTION 'RTBF anonymize: at least one of p_subject_email or p_subject_phone required';
  END IF;
  IF p_ticket_ref IS NULL THEN
    RAISE EXCEPTION 'RTBF anonymize: p_ticket_ref required for audit trail (e.g. RTBF-2026-08-14-001)';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'RTBF anonymize: p_actor required for audit trail (e.g. founder email)';
  END IF;

  v_marker := '[RTBF-anon-' || to_char(now(), 'YYYY-MM-DD') || '-' || p_ticket_ref || ']';

  RAISE NOTICE 'RTBF anonymize starting: subject_email=%, subject_phone=%, ticket=%, actor=%, marker=%',
    COALESCE(p_subject_email, '(none)'),
    COALESCE(p_subject_phone, '(none)'),
    p_ticket_ref,
    p_actor,
    v_marker;

  FOR v_row IN
    SELECT id, context, created_at
    FROM public.alerts
    WHERE (p_subject_email IS NOT NULL AND POSITION('"' || p_subject_email || '"' IN context::text) > 0)
       OR (p_subject_phone IS NOT NULL AND POSITION('"' || p_subject_phone || '"' IN context::text) > 0)
    FOR UPDATE
  LOOP
    v_matched := v_matched + 1;

    IF v_row.created_at < v_era1_end THEN
      v_era := 'era1_pre_redaction';
    ELSIF v_row.created_at < v_era2_end THEN
      v_era := 'era2_over_redacted';
    ELSE
      v_era := 'era3_architecture_b';
    END IF;

    IF NOT (v_era = ANY(v_eras)) THEN
      v_eras := array_append(v_eras, v_era);
    END IF;

    v_new_ctx := public.rtbf_walk_jsonb(v_row.context, v_marker);

    IF v_new_ctx IS DISTINCT FROM v_row.context THEN
      UPDATE public.alerts SET context = v_new_ctx WHERE id = v_row.id;
      v_anonymized := v_anonymized + 1;
    END IF;
  END LOOP;

  -- Self-audit row. sent_to='audit-only:rtbf' is the sentinel documented in
  -- the file header (see "Self-audit convention"). RTBF_EXECUTED is not in
  -- ALERT_CONFIG so alert-founder ignores it — this row is DB-only.
  INSERT INTO public.alerts (alert_type, severity, sent_to, context)
  VALUES (
    'RTBF_EXECUTED',
    'INFO',
    'audit-only:rtbf',
    jsonb_build_object(
      'ticket_ref', p_ticket_ref,
      'actor', p_actor,
      'rows_matched', v_matched,
      'rows_anonymized', v_anonymized,
      'eras_touched', v_eras,
      'executed_at', now(),
      'marker_used', v_marker
    )
  );

  RETURN QUERY SELECT v_matched, v_anonymized, v_eras;
END $$;

COMMENT ON FUNCTION public.rtbf_anonymize_alerts_context(text, text, text, text) IS
  'RTBF Stage 4: anonymize all PII in alerts rows referencing the given subject. SECURITY DEFINER bypasses RLS. Handles three-era state model (pre-redaction / over-redacted / Architecture B). Self-audits via RTBF_EXECUTED alerts row (sent_to=audit-only:rtbf sentinel). See SOP Master §3.';
