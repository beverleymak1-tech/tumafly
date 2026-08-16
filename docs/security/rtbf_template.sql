-- docs/security/rtbf_template.sql
--
-- RIGHT-TO-BE-FORGOTTEN (RTBF) OPERATIONAL TEMPLATE
--
-- Version: Session 35c (2026-08-15) — Stage 4 now invokes Postgres function
--
-- Purpose: fulfill a single verified RTBF request against a data subject.
-- Governance: SOP Master §3. Never execute without completing §3.4 (identity
-- verification) and §3.5 (identifier-format check) first.
--
-- BEFORE RUNNING:
--   1. Complete SOP §3.4 identity verification protocol
--   2. Complete SOP §3.5 mandatory identifier-format check via information_schema
--      lookup — this template uses EXACT string matching; format mismatches
--      cause silent PII preservation
--   3. Substitute all <ANGLE_BRACKET_PLACEHOLDERS> below with verified values
--   4. Run inside a transaction. Review counts at each stage. COMMIT only if
--      counts match expectations. ROLLBACK if any stage returns unexpected data.
--   5. Retain the psql session log as evidence for the 30-day response-window
--      audit trail per SOP §3.7
--
-- ROWS PRESERVED (per DPA 2019 §40 exceptions / KRA 7-year record-keeping):
--   - bookings: row kept for tax audit; passenger PII replaced with anon marker; user_id nulled by cascade
--   - pending_bookings: same posture
--   - refunds: kept for financial audit; customer_email anonymized
--   - alerts: kept for security audit; PII keys in context anonymized via rtbf_anonymize_alerts_context() function
--
-- ROWS DELETED OUTRIGHT:
--   - saved_travelers: no legal-retention obligation
--   - auth.users: identity record; CASCADE deletes profiles, SET NULL on bookings/pending user_id
--
-- FUTURE STATE (post-launch, once Ops-1 dashboard ships):
--   This template becomes the internal reference for the Ops-1 dashboard RTBF
--   Requests page. The dashboard will invoke the same Postgres function
--   (Stage 4) as a primitive; the manual SQL below will only be run when the
--   dashboard is unavailable (fallback path).

BEGIN;

-- ===== STAGE 0: CAPTURE IDENTIFIERS =====
-- Capture email/phone we'll need after auth.users is deleted (Stage 6).
-- For guest customers (no auth.users row), these will come from the pending_bookings.contact jsonb.

DO $$
DECLARE
  v_target uuid := '<SUBJECT_USER_UUID_OR_NULL_FOR_GUEST>'::uuid;  -- from SOP §3.5 auth.users lookup; NULL if guest
  v_ticket text := '<TICKET_REF>';       -- from SOP §3.3 (e.g., 'RTBF-2026-08-15-001')
  v_actor text := '<OPERATOR_EMAIL>';    -- operator identifying email (e.g., 'founder@tumafly.com')
  v_subject_email text := '<SUBJECT_EMAIL>';  -- from SOP §3.5 lookup, exact format as stored
  v_subject_phone text := '<SUBJECT_PHONE>';  -- from SOP §3.5 lookup, exact format as stored
  v_anon_tag text;
  v_rtbf_result record;
  v_count int;
BEGIN
  v_anon_tag := '[REDACTED-RTBF-' || to_char(now(), 'YYYY-MM-DD') || '-' || v_ticket || ']';

  RAISE NOTICE 'RTBF starting: user_uuid=%, email=%, phone=%, ticket=%, actor=%, marker=%',
    COALESCE(v_target::text, '(guest)'), v_subject_email, v_subject_phone, v_ticket, v_actor, v_anon_tag;

  -- ===== STAGE 1: ANONYMIZE bookings PII =====
  -- Only runs if signed-in account (v_target IS NOT NULL). For guest customers,
  -- bookings link via pending_booking_id but user_id is NULL — no direct match.

  IF v_target IS NOT NULL THEN
    UPDATE public.bookings
    SET passenger_name = v_anon_tag,
        passenger_email = v_anon_tag,
        passenger_phone = v_anon_tag,
        passenger_details = jsonb_build_object('_redacted', v_anon_tag),
        updated_at = now()
    WHERE user_id = v_target;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'Stage 1 bookings anonymized: % rows', v_count;
  ELSE
    RAISE NOTICE 'Stage 1 SKIPPED — guest customer (no user_id match). Manual review may be required for guest bookings linked via contact.email.';
  END IF;

  -- ===== STAGE 2: ANONYMIZE pending_bookings PII =====

  IF v_target IS NOT NULL THEN
    UPDATE public.pending_bookings
    SET contact = COALESCE(contact - 'email' - 'phone_number', '{}'::jsonb) || jsonb_build_object('_redacted', v_anon_tag),
        passengers = jsonb_build_object('_redacted', v_anon_tag),
        updated_at = now()
    WHERE user_id = v_target;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'Stage 2 pending_bookings anonymized (signed-in): % rows', v_count;
  END IF;

  -- Guest path: match via contact.email
  UPDATE public.pending_bookings
  SET contact = COALESCE(contact - 'email' - 'phone_number', '{}'::jsonb) || jsonb_build_object('_redacted', v_anon_tag),
      passengers = jsonb_build_object('_redacted', v_anon_tag),
      updated_at = now()
  WHERE user_id IS NULL
    AND (contact->>'email' = v_subject_email OR contact->>'phone_number' = v_subject_phone);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Stage 2 pending_bookings anonymized (guest): % rows', v_count;

  -- ===== STAGE 3: ANONYMIZE refunds.customer_email =====
  -- Refunds link to pending_bookings; anonymize via that path.

  UPDATE public.refunds r
  SET customer_email = v_anon_tag, updated_at = now()
  FROM public.pending_bookings pb
  WHERE r.pending_booking_id = pb.id
    AND (
      (v_target IS NOT NULL AND pb.user_id = v_target)
      OR (pb.user_id IS NULL AND (pb.contact->>'email' = v_subject_email OR r.customer_email = v_subject_email))
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Stage 3 refunds anonymized: % rows', v_count;

  -- ===== STAGE 4: ANONYMIZE alerts.context PII =====
  -- Session 35c: this stage is now a Postgres function invocation, not inline SQL.
  -- The function handles the three-era state model of the alerts table:
  --   era1_pre_redaction (pre-2026-08-13): raw PII, must anonymize
  --   era2_over_redacted (2026-08-13 → 2026-08-14 17:54): PII stored as "[REDACTED]" literal; anonymization is idempotent no-op
  --   era3_architecture_b (post-2026-08-14 17:54): raw PII (Arch B preserved), must anonymize
  --
  -- The function uses byte-exact match on quote-delimited subject strings —
  -- SOP §3.5 identifier-format check is what makes this safe.
  --
  -- Function also writes a self-audit RTBF_EXECUTED row with sent_to='audit-only:rtbf'
  -- sentinel — this satisfies DPA §26 accountability and provides the evidence
  -- the operator retrieves in SOP §3.7 for the customer response.

  SELECT * INTO v_rtbf_result FROM public.rtbf_anonymize_alerts_context(
    p_subject_email := v_subject_email,
    p_subject_phone := v_subject_phone,
    p_ticket_ref    := v_ticket,
    p_actor         := v_actor
  );
  RAISE NOTICE 'Stage 4 alerts: matched=% anonymized=% eras=%',
    v_rtbf_result.rows_matched,
    v_rtbf_result.rows_anonymized,
    v_rtbf_result.eras_touched;

  -- ===== STAGE 5: DELETE saved_travelers =====

  IF v_target IS NOT NULL THEN
    DELETE FROM public.saved_travelers WHERE user_id = v_target;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'Stage 5 saved_travelers deleted: % rows', v_count;
  ELSE
    RAISE NOTICE 'Stage 5 SKIPPED — guest customer has no saved_travelers.';
  END IF;

  -- ===== STAGE 6: DELETE auth.users =====
  -- CASCADE deletes profiles, SET NULLs user_id on bookings/pending_bookings.

  IF v_target IS NOT NULL THEN
    DELETE FROM auth.users WHERE id = v_target;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'Stage 6 auth.users deleted: % rows (cascades profiles; nulls user_id on bookings/pending)', v_count;
  ELSE
    RAISE NOTICE 'Stage 6 SKIPPED — guest customer has no auth.users row.';
  END IF;

  RAISE NOTICE 'RTBF template execution complete for ticket %.', v_ticket;
END $$;

-- ===== POST-EXECUTION SANITY CHECKS =====
-- Run these AFTER the DO block but BEFORE COMMIT. If any fail, ROLLBACK.
--
-- 1. Deletion + cascade evidence (for signed-in accounts; expected: 0 for all):
--    SELECT COUNT(*) FROM auth.users WHERE id = '<SUBJECT_USER_UUID>'::uuid;
--    SELECT COUNT(*) FROM public.profiles WHERE id = '<SUBJECT_USER_UUID>'::uuid;
--    SELECT COUNT(*) FROM public.saved_travelers WHERE user_id = '<SUBJECT_USER_UUID>'::uuid;
--
-- 2. Anonymization evidence (rows should show anonymized values):
--    SELECT passenger_email FROM public.bookings WHERE passenger_email LIKE '[REDACTED-RTBF-%<TICKET_REF>]';
--    SELECT context->>'_redacted' FROM public.pending_bookings WHERE passengers ? '_redacted';
--    SELECT customer_email FROM public.refunds WHERE customer_email LIKE '[REDACTED-RTBF-%<TICKET_REF>]';
--
-- 3. alerts audit trail (RTBF_EXECUTED row should exist for the ticket):
--    SELECT context FROM public.alerts WHERE alert_type = 'RTBF_EXECUTED' AND context->>'ticket_ref' = '<TICKET_REF>';

COMMIT;  -- change to ROLLBACK if any stage looked wrong per SOP §3.6

-- After COMMIT, retrieve the RTBF_EXECUTED row per SOP §3.7 to compose
-- the written response to the data subject.
