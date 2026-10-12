-- Session 48 · TEMPORARY retry-schedule characterization table
-- Spec: claude/TumaFly_Session47_DesignSpec_DuffelWebhookRedesign.md section 4.2
-- Captures (received_at, request_id, pending_booking_id, user_agent) at
-- process-duffel-booking handler head to measure DB-webhook retry schedule
-- empirically. Findings feed RUNBOOK section 19.b (Session 49 close bundle).
--
-- REMOVAL: Session 49 close bundle drops this table along with the handler-
-- head instrumentation in process-duffel-booking/index.ts. Table name prefix
-- `tempmetric_` makes it unmistakably not-production-data.

CREATE TABLE IF NOT EXISTS public.tempmetric_pdb_invocations (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at          timestamptz  NOT NULL DEFAULT now(),
  pending_booking_id   uuid         NULL,
  request_id           text         NULL,
  user_agent           text         NULL
);

CREATE INDEX IF NOT EXISTS tempmetric_pdb_invocations_pending_booking_id_idx
  ON public.tempmetric_pdb_invocations (pending_booking_id, received_at)
  WHERE pending_booking_id IS NOT NULL;

ALTER TABLE public.tempmetric_pdb_invocations ENABLE ROW LEVEL SECURITY;
-- No policies — service role only (same pattern as audit_log, csp_violations).

COMMENT ON TABLE public.tempmetric_pdb_invocations IS
  'TEMPORARY (Session 48 only). DB-webhook retry-schedule characterization data for process-duffel-booking. Dropped in Session 49 close bundle. See spec section 4.2.';