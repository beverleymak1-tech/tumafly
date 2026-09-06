-- Session S-14b — pre-migration snapshots for booking-path encryption extension.
-- Retention: 30 days from application. DROP scheduled per running-updates log.
--
-- Snapshots are deny-all-by-default: RLS enabled with no policies attached,
-- and PostgREST-visible grants revoked from anon + authenticated.
-- Access is service-role-only, matching the posture of the source tables.

CREATE TABLE public.pending_bookings_pre_s14b_backup AS
  SELECT * FROM public.pending_bookings;

CREATE TABLE public.bookings_pre_s14b_backup AS
  SELECT * FROM public.bookings;

CREATE TABLE public.saved_travelers_pre_s14c_backup AS
  SELECT * FROM public.saved_travelers;

ALTER TABLE public.pending_bookings_pre_s14b_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings_pre_s14b_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_travelers_pre_s14c_backup ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pending_bookings_pre_s14b_backup FROM anon, authenticated;
REVOKE ALL ON public.bookings_pre_s14b_backup FROM anon, authenticated;
REVOKE ALL ON public.saved_travelers_pre_s14c_backup FROM anon, authenticated;
