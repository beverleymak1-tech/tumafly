-- Session 28c commit #10d (hotfix)
-- Guard *_select_own RLS policies from firing when a guest JWT is present.
--
-- Without this guard, Realtime's internal realtime.apply_rls() function
-- would attempt to cast the guest JWT's sub claim to uuid via auth.uid(),
-- fail with 22P02 invalid_text_representation, and silently drop the
-- change delivery without any client-visible error.
--
-- The guard clause `auth.jwt() ->> 'guest_pending_booking_id' IS NULL`
-- short-circuits the policy to false for any guest JWT, before Postgres
-- ever tries to evaluate auth.uid(). Real authenticated users have no
-- such claim, so the guard is NULL IS NULL = true and behavior is
-- unchanged for them.
--
-- Also fixed: mint-guest-token EF now sets sub to the raw pending_booking_id
-- (a valid uuid) instead of "guest:<uuid>". This is the belt-and-suspenders
-- fix — Realtime's apply_rls sets auth.uid() internally regardless of our
-- policies, and it must be uuid-castable. Safe because these guarded
-- policies short-circuit before auth.uid() would matter.

BEGIN;

DROP POLICY IF EXISTS pending_bookings_select_own ON public.pending_bookings;
CREATE POLICY pending_bookings_select_own
  ON public.pending_bookings
  FOR SELECT
  USING (
    auth.jwt() ->> 'guest_pending_booking_id' IS NULL
    AND auth.uid() IS NOT NULL
    AND auth.uid() = user_id
  );

DROP POLICY IF EXISTS "Users can read their own bookings" ON public.bookings;
CREATE POLICY "Users can read their own bookings"
  ON public.bookings
  FOR SELECT
  USING (
    auth.jwt() ->> 'guest_pending_booking_id' IS NULL
    AND auth.uid() IS NOT NULL
    AND auth.uid() = user_id
  );

DROP POLICY IF EXISTS booking_status_history_select_own ON public.booking_status_history;
CREATE POLICY booking_status_history_select_own
  ON public.booking_status_history
  FOR SELECT
  USING (
    auth.jwt() ->> 'guest_pending_booking_id' IS NULL
    AND auth.uid() IS NOT NULL
    AND (
      (booking_table = 'pending_bookings' AND EXISTS (
        SELECT 1 FROM public.pending_bookings p
        WHERE p.id = booking_status_history.booking_id
          AND p.user_id = auth.uid()
      ))
      OR
      (booking_table = 'bookings' AND EXISTS (
        SELECT 1 FROM public.bookings b
        WHERE b.id = booking_status_history.booking_id
          AND b.user_id = auth.uid()
      ))
    )
  );

COMMIT;
