-- session_s09_retention_jobs.sql
--
-- Session 35 S-09: two pg_cron retention jobs for guest data hygiene.
-- Aligns with Privacy Notice §10 retention schedule (Legal batch pending Session 35c).
--
-- These jobs were applied via SQL Editor during Session 35 (jobids 5+6).
-- This file commits the applied state to git for repro/audit purposes.
-- IF NOT EXISTS guards make the file safe to re-run in any environment.
--
-- Job schedules use weekly Sunday 02:00 UTC to avoid conflict with:
--   - jobid 1 (retry-stuck-bookings, every minute)
--   - jobid 2 (sweep_orphan_pending_bookings_nightly, 03:00 UTC daily)
--   - jobid 3 (otp_attempts_cleanup, 03:00 UTC daily)
--   - jobid 4 (alerts_retention_365d, 04:00 UTC daily)
--
-- FK safety note (rtbf_abandoned_guest_pending_delete):
--   Deletes only pending_bookings in ('pending', 'failed_to_create') states.
--   Both states are pre-payment — no linked refunds exist, so no FK conflict.
--   Deliberately excludes: paid_booking_failed, paid_offer_expired, refund_*.

DO $$
BEGIN
  -- Job 5: rtbf_guest_contact_trim
  -- Trims contact.email + contact.phone_number from pending_bookings where
  -- linked booking's travel date is >90 days past AND user_id IS NULL (guest).
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rtbf_guest_contact_trim') THEN
    PERFORM cron.schedule(
      'rtbf_guest_contact_trim',
      '0 2 * * 0',
      $query$
      UPDATE public.pending_bookings pb
      SET contact = pb.contact - 'email' - 'phone_number',
          updated_at = now()
      FROM public.bookings b
      WHERE b.pending_booking_id = pb.id
        AND pb.user_id IS NULL
        AND GREATEST(b.departure_at, COALESCE(b.return_date, b.departure_at)) < now() - interval '90 days'
        AND (pb.contact ? 'email' OR pb.contact ? 'phone_number');
      $query$
    );
  END IF;

  -- Job 6: rtbf_abandoned_guest_pending_delete
  -- Deletes pending_bookings in pre-payment states after 30d inactivity, guest only.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rtbf_abandoned_guest_pending_delete') THEN
    PERFORM cron.schedule(
      'rtbf_abandoned_guest_pending_delete',
      '0 2 * * 0',
      $query$
      DELETE FROM public.pending_bookings
      WHERE user_id IS NULL
        AND status IN ('pending', 'failed_to_create')
        AND updated_at < now() - interval '30 days';
      $query$
    );
  END IF;
END $$;

-- Verify after apply:
--   SELECT jobid, jobname, schedule FROM cron.job WHERE jobname LIKE 'rtbf_%';
--   Expected: 2 rows (jobids 5+6 in current prod; new IDs elsewhere).
