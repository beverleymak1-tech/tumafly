-- Session 40 · Ops-1 foundation: audit_log table.
--
-- Per TumaFly_Handoff_2_Ops_Dashboard_Buildout.md §Ops-1.
--
-- Purpose: Every meaningful action taken by the system, ops staff, or customers
-- (as they mutate booking/payment/refund/cancellation state) writes a row here.
-- The invisible half of the ops dashboard — every action is auditable.
--
-- Actor convention:
--   actor_type = 'system'   → actor_id = source EF name (e.g. 'initialize-payment')
--   actor_type = 'ops'      → actor_id = ops user email
--   actor_type = 'customer' → actor_id = user_id (or 'guest:<guest_token>' for guests)
--
-- Target convention:
--   target_type = 'pending_booking' | 'booking' | 'refund' | 'cancellation'
--   target_id   = the UUID of the target row (stored as text for search flexibility)
--
-- Access:
--   RLS enabled with NO policies — service role only. Ops dashboard reads happen
--   via an ops-role-gated EF (Ops-4 timeline panel), which uses service role to
--   query. No direct anon/authenticated access.
--
-- Indexes:
--   - target_idx: fast "show me every action against this booking" (Ops-4 timeline)
--   - actor_idx:  fast "show me every action taken by this ops user" (accountability)
--   - action_idx: fast "show me all payment_captured events last week" (Ops-M metrics)
--
-- No retention policy at launch — audit_log is compliance data, keep indefinitely.
-- Volume estimate: ~10 rows per booking (initialize + verify + captured + created
-- + confirmation ×2 + any refund flow). At 100 bookings/day = 1000 rows/day =
-- ~365k rows/year. Trivial for postgres.
--
-- Applied via Supabase SQL Editor on 2026-09-08.

CREATE TABLE public.audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   text NOT NULL,           -- 'system' | 'ops' | 'customer'
  actor_id     text,                    -- see actor convention above; NULL only for anon system events
  action_type  text NOT NULL,           -- e.g. 'payment_initialized', 'refund_initiated'
  target_type  text NOT NULL,           -- 'pending_booking' | 'booking' | 'refund' | 'cancellation'
  target_id    text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_target_idx ON public.audit_log (target_type, target_id, created_at DESC);
CREATE INDEX audit_log_actor_idx  ON public.audit_log (actor_type, actor_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON public.audit_log (action_type, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies. Service role bypasses RLS. Anon and authenticated
-- have zero access. Ops dashboard reads go through service-role EFs.

COMMENT ON TABLE public.audit_log IS
  'Ops-1 audit trail. Every meaningful state transition writes one row. Service-role-only via RLS.';

COMMENT ON COLUMN public.audit_log.actor_id IS
  'System: source EF name. Ops: email. Customer: user_id (or guest:<token> for guests).';

COMMENT ON COLUMN public.audit_log.payload IS
  'Structured event context. Amounts, currencies, error details, state transitions. Never PII in cleartext.';

-- Verification:
SELECT
  (SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'audit_log' AND schemaname = 'public') AS index_count,
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'audit_log' AND relnamespace = 'public'::regnamespace) AS rls_enabled,
  (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'audit_log' AND schemaname = 'public') AS policy_count;
-- Expected: index_count=4 (3 named + 1 PK), rls_enabled=true, policy_count=0