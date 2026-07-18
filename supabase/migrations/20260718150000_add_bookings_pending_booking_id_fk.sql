-- Session 28b #3: add FK constraint on bookings.pending_booking_id.
--
-- Prereq: commit #2 (20260718140000) added the column and backfilled
-- values via duffel_order_id match. All existing rows are guaranteed
-- to satisfy this constraint:
--   - 56 rows reference a real pending_bookings.id (backfilled)
--   - 7 rows are NULL (Pesapal-era orphans; FKs tolerate NULL)
--
-- ON DELETE RESTRICT matches refunds.pending_booking_id_fkey pattern:
-- a pending_bookings row with a real booking attached cannot be deleted
-- accidentally. Consistent policy across the two child tables.
--
-- NOT VALID + VALIDATE pattern: adds the constraint without an exclusive
-- lock during the row-by-row check, then validates in a separate
-- lightweight pass. Zero downtime at any table size. No cost to use
-- the pattern now.

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_pending_booking_id_fkey
  FOREIGN KEY (pending_booking_id)
  REFERENCES public.pending_bookings(id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.bookings
  VALIDATE CONSTRAINT bookings_pending_booking_id_fkey;
