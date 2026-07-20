-- Session 28c commit #10a
-- Add per-row guest_token to pending_bookings for Realtime auth.
-- The token is the auth-establishing secret; mint-guest-token EF (#10c)
-- will exchange it for a scoped JWT with a guest_pending_booking_id claim
-- that RLS policies (#10b) grant SELECT with.
--
-- Nullable to start. NOT NULL enforcement deferred until the EF code change
-- (populate on every new INSERT) is deployed and verified.

BEGIN;

ALTER TABLE public.pending_bookings
  ADD COLUMN IF NOT EXISTS guest_token text;

COMMENT ON COLUMN public.pending_bookings.guest_token IS
  'Per-row secret for Realtime auth. 256-bit hex. Exchanged for a scoped JWT via mint-guest-token EF. See Session 28c commit #10a.';

-- Backfill any existing row that has NULL. Harmless for terminal-state
-- rows (booked/cancelled/refunded) — they can still support Realtime
-- reconnects in the unlikely case a customer reopens their success page.
UPDATE public.pending_bookings
SET guest_token = encode(gen_random_bytes(32), 'hex')
WHERE guest_token IS NULL;

COMMIT;
