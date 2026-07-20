-- Session 28c commit #10c (Artifact 1 of 3)
-- Per-row failed-attempt counter for mint-guest-token EF.
--
-- Threat model:
--   Someone who has (guessed / obtained) a valid pending_booking_id but
--   is trying to brute-force the 256-bit guest_token. Every failed mint
--   attempt against that ID increments this counter; at threshold 20
--   the mint EF refuses further attempts on that row.
--
-- 2^256 makes actual token brute force infeasible, but this bounds the
-- endpoint's log noise and makes the pattern detectable ambient-alerts.
--
-- Scaling note: per-IP throttling (option 3 in mint-guest-token design
-- discussion) is NOT implemented here. Trigger for adding it: either
--   (a) crossing ~1,000 bookings/month, or
--   (b) alert-stream signal that mint-guest-token failures are
--       concentrated per-IP rather than per-pending-booking-id.

BEGIN;

ALTER TABLE public.pending_bookings
  ADD COLUMN IF NOT EXISTS guest_token_attempts int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.pending_bookings.guest_token_attempts IS
  'Counter of failed mint-guest-token attempts for this row. Increments on token mismatch. Row is refused further mints once counter >= 20. See Session 28c commit #10c.';

COMMIT;
