-- Session 28b #2: add pending_booking_id to bookings, backfill via duffel_order_id.
--
-- Rationale: bookings and pending_bookings currently have no formal FK
-- relationship. Historical result: cannot cleanly reconstruct customer
-- journeys (payment → ticketing → refund) via SQL joins. Session 28b
-- lands a proper link, backfills history where possible, and enforces
-- referential integrity going forward (FK added in commit #3).
--
-- Backfill key: bookings.duffel_order_id ↔ pending_bookings.duffel_order_id
-- Both columns are populated by paystack-webhook writing the Duffel
-- response's order.id verbatim into both tables. Verified in production
-- at Session 28b #2 open:
--   - 63 total bookings rows
--   - 63 have duffel_order_id populated
--   - 56 match a pending_bookings row via duffel_order_id
--   - 0 duplicates in pending_bookings.duffel_order_id (1:1 guaranteed)
--
-- 7 orphan bookings rows (63 − 56) predate reliable pending_bookings
-- rows. They remain permanent NULLs on pending_booking_id — accepted
-- historical debt, called out here explicitly rather than fabricated.

-- 1. Add the column, nullable, no default.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS pending_booking_id uuid;

-- 2. Backfill from pending_bookings via duffel_order_id.
--    Idempotent: WHERE b.pending_booking_id IS NULL prevents overwrite
--    on replay; the match on duffel_order_id is stable (never rewritten).
UPDATE public.bookings b
SET pending_booking_id = pb.id
FROM public.pending_bookings pb
WHERE b.duffel_order_id = pb.duffel_order_id
  AND b.pending_booking_id IS NULL;

-- 3. Index for efficient FK constraint checks (commit #3) and for
--    downstream joins in Session 30's ops dashboard.
CREATE INDEX IF NOT EXISTS bookings_pending_booking_id_idx
  ON public.bookings (pending_booking_id);
