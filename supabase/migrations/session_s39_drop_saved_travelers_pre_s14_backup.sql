-- session_s39_drop_saved_travelers_pre_s14_backup.sql
--
-- Session 39 Task 5 — drop the S-14 pre-migration backup table.
--
-- Applied via SQL Editor on 2026-09-04. This file commits the applied state
-- to git per the session_sXX convention (see session_s12_cleanup_saved_
-- travelers_duplicate_policies.sql for the pattern).
--
-- Context: `saved_travelers_pre_s14_backup` was created in Session 14 as a
-- snapshot before a schema migration on saved_travelers. Session 38 handoff
-- cleared it for drop on/after 2026-08-26 (retention window closed). At
-- drop time it held 6 rows.
--
-- Safe because:
--   - No live code references saved_travelers_pre_s14_backup (grep-verified
--     against supabase/ tree in Session 39).
--   - The retention window (10 days post-clearance) was exceeded — if a
--     restore was going to be needed, it would have been triggered.
--   - Row count small (6) so worst-case restore effort would be trivial
--     from Supabase's daily automated backups.
--
-- Rollback (if ever needed): restore from Supabase's automated backup for
--   a date on or before 2026-09-04.

DROP TABLE IF EXISTS public.saved_travelers_pre_s14_backup;

-- Verify after apply:
--   SELECT tablename FROM pg_tables WHERE tablename = 'saved_travelers_pre_s14_backup';
--   Expected: 0 rows.