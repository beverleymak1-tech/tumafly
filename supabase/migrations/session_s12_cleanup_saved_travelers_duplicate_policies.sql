-- session_s12_cleanup_saved_travelers_duplicate_policies.sql
--
-- Drop 4 snake_case duplicate policies on saved_travelers.
-- Verified byte-identical to the Title Case set via Session 35 S-12 Phase 1 audit
-- (same polcmd, same using_clause, same with_check_clause per pg_policy).
-- The Title Case set ("Users can ...") + "Service role full access" remain canonical.
-- Post-drop expected policy count on saved_travelers: 5.

DROP POLICY IF EXISTS users_insert_own_travelers ON public.saved_travelers;
DROP POLICY IF EXISTS users_delete_own_travelers ON public.saved_travelers;
DROP POLICY IF EXISTS users_view_own_travelers   ON public.saved_travelers;
DROP POLICY IF EXISTS users_update_own_travelers ON public.saved_travelers;
