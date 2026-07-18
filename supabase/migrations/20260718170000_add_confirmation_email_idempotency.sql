-- Session 28b #7a: send-confirmation idempotency column.
--
-- Adds pending_bookings.confirmation_email_sent_at for send-confirmation
-- fire-once semantics. Same pattern as Session 28a's
-- refund_notification_sent_at and refund_settled_notification_sent_at
-- columns on the refunds table.
--
-- Rationale: send-confirmation currently fires from exactly one place
-- (paystack-webhook, prior to commit #6's refactor). After commits
-- #7-#9, send-confirmation will fire from THREE possible call sites:
--
--   1. process-duffel-booking (commit #7) — sync happy path when
--      Duffel returns 200 + documents populated.
--   2. Duffel order.created webhook handler (commit #8) — async
--      happy path when documents are populated at the moment
--      Duffel notifies us the order was created.
--   3. retry-stuck-bookings reconciler (commit #9) — polled happy
--      path when a pnr_issued row's documents become populated on
--      GET /air/orders/:id.
--
-- Any of the three code paths can win the race in edge cases (e.g.
-- Duffel returns instantly AND fires order.created before we process
-- the sync response). This column guards send-confirmation so that
-- the second-and-onward callers see the timestamp and no-op.
--
-- Idempotent: IF NOT EXISTS. Safe to replay.

ALTER TABLE public.pending_bookings
  ADD COLUMN IF NOT EXISTS confirmation_email_sent_at timestamptz;

COMMENT ON COLUMN public.pending_bookings.confirmation_email_sent_at IS
  'Set when the customer booking-confirmation email is sent via '
  'send-confirmation. Guard for fire-once semantics across '
  'process-duffel-booking, order.created webhook handler, and the '
  'ticket-issuance reconciler. Session 28b #7a.';
