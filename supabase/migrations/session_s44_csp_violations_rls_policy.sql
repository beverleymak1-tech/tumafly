-- session_s44_csp_violations_rls_policy.sql
-- ============================================================================
-- Session 44 durable fix-forward: csp_violations RLS policy
-- ============================================================================
-- Discovered: Session 44 (2026-09-25), during A3 csp-report deploy verification.
--
-- Context:
--   Session 42's csp_violations migration created the table with
--   ALTER TABLE ... ENABLE ROW LEVEL SECURITY but never added a policy
--   allowing service_role writes. PostgREST returns success shape on
--   RLS-denied inserts (rows silently filtered), so csp-report EF's
--   INSERT succeeded from the client's view but wrote zero rows.
--
--   Result: bake window DB stream captured zero rows Session 42 push
--   → Session 44 fix. Function Log stream (24h retention on free tier)
--   also lost most of the bake window data. Anytime-flex CSP enforcing
--   promote trigger moved from 2026-09-30 → 2026-10-02 (7 days from
--   RLS fix landing to restart the durable-DB bake window).
--
-- Fix: grant service_role FOR ALL on csp_violations. csp-report EF runs
-- as service_role, so this restores the DB write path without weakening
-- RLS for other roles (anon/authenticated remain denied — correct: only
-- server-side EFs should write CSP violation rows).
--
-- Idempotent: uses DO block with pg_policies check so re-running is safe.
-- Applied live via SQL editor on both A3 (nljxqcrmmkodbzsrzdba) and
-- production (wmplcauhaqtyenwvkrkq) on 2026-09-25 before this migration
-- landed in the repo.
--
-- See Session 44 RUNBOOK addition on RLS-enabled tables requiring explicit
-- service_role policies (class-of-issue also seen with pending_bookings in
-- an earlier session), and Session 44 handoff notes.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'csp_violations'
      AND policyname = 'service_role_all_csp_violations'
  ) THEN
    CREATE POLICY "service_role_all_csp_violations"
      ON public.csp_violations
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;