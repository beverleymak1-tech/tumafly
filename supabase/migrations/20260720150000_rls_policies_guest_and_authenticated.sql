-- Session 28c commit #10b
-- RLS policies for guest and authenticated SELECT access on the three
-- tables the #success page needs to subscribe to:
--   - pending_bookings, bookings, booking_status_history
--
-- Two classes of caller:
--   1. AUTHENTICATED user with a Supabase auth session:
--      - pending_bookings.user_id = auth.uid()
--      - bookings.user_id = auth.uid()  (existing policy — untouched)
--      - booking_status_history: joined via either table
--
--   2. GUEST user with a scoped JWT minted by mint-guest-token (#10c):
--      - JWT claim guest_pending_booking_id matches pending_bookings.id
--      - For bookings/history: same claim, joined via pending_booking_id
--
-- The service_role continues to bypass RLS entirely — all Edge Functions
-- keep working unchanged.
--
-- Idempotent: every policy is DROP IF EXISTS + CREATE. Re-runnable.

BEGIN;

-- ---------------------------------------------------------------
-- 1. pending_bookings  (RLS already enabled, no existing policies)
-- ---------------------------------------------------------------

ALTER TABLE public.pending_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pending_bookings_select_own ON public.pending_bookings;
CREATE POLICY pending_bookings_select_own
  ON public.pending_bookings
  FOR SELECT
  USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);

DROP POLICY IF EXISTS pending_bookings_select_guest ON public.pending_bookings;
CREATE POLICY pending_bookings_select_guest
  ON public.pending_bookings
  FOR SELECT
  USING (
    (auth.jwt() ->> 'guest_pending_booking_id')::uuid = id
  );

-- ---------------------------------------------------------------
-- 2. bookings  (RLS already enabled; existing user_id policy stays)
-- ---------------------------------------------------------------

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

-- Existing authenticated-user policy is untouched. Add guest policy.
DROP POLICY IF EXISTS bookings_select_guest ON public.bookings;
CREATE POLICY bookings_select_guest
  ON public.bookings
  FOR SELECT
  USING (
    pending_booking_id IS NOT NULL
    AND (auth.jwt() ->> 'guest_pending_booking_id')::uuid = pending_booking_id
  );

-- ---------------------------------------------------------------
-- 3. booking_status_history  (RLS NOT yet enabled per Session 28b close)
-- ---------------------------------------------------------------

ALTER TABLE public.booking_status_history ENABLE ROW LEVEL SECURITY;

-- Authenticated: match through either source table's user_id
DROP POLICY IF EXISTS booking_status_history_select_own ON public.booking_status_history;
CREATE POLICY booking_status_history_select_own
  ON public.booking_status_history
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL AND (
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

-- Guest: match through the JWT claim, via either source table
DROP POLICY IF EXISTS booking_status_history_select_guest ON public.booking_status_history;
CREATE POLICY booking_status_history_select_guest
  ON public.booking_status_history
  FOR SELECT
  USING (
    (booking_table = 'pending_bookings'
     AND (auth.jwt() ->> 'guest_pending_booking_id')::uuid = booking_id)
    OR
    (booking_table = 'bookings' AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = booking_status_history.booking_id
        AND b.pending_booking_id IS NOT NULL
        AND (auth.jwt() ->> 'guest_pending_booking_id')::uuid = b.pending_booking_id
    ))
  );

COMMIT;
