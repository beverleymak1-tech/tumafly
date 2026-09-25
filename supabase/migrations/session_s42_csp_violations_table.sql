-- Session 42 — csp_violations table
-- Persists CSP violation reports received by csp-report EF for durable
-- bake-window analysis. Supersedes log-only sink from Session 40 S-01a
-- (Supabase free tier only retains 1 day of function logs).
--
-- Access model: service-role-only. RLS enabled with zero policies —
-- same pattern as audit_log (Session 40 S-16). csp-report EF writes via
-- service role; nobody else reads except operators via SQL editor.
--
-- Retention: currently unbounded. If growth becomes an issue post-launch,
-- add a scheduled cleanup (e.g., delete rows > 90 days old).

BEGIN;

CREATE TABLE IF NOT EXISTS public.csp_violations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  source_ip          text,
  document_uri       text,
  violated_directive text,
  blocked_uri        text,
  source_file        text,
  line_number        integer,
  script_sample      text,
  user_agent         text
);

CREATE INDEX IF NOT EXISTS idx_csp_violations_created_at
  ON public.csp_violations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_csp_violations_directive_uri
  ON public.csp_violations (violated_directive, blocked_uri);

ALTER TABLE public.csp_violations ENABLE ROW LEVEL SECURITY;
-- Zero policies: service-role bypasses RLS; no other role can read.

COMMENT ON TABLE public.csp_violations IS
  'CSP violation reports received via csp-report EF. Session 42.';

COMMIT;