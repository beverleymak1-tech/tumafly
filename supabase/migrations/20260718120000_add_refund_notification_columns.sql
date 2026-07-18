-- Session 28a: idempotency columns for the customer refund notification
-- email flow (send-refund-notification EF).
--
-- Originally applied ad-hoc via SQL Editor at Session 28a open.
-- Backfilled into this directory as part of Session 28b commit #0.

ALTER TABLE public.refunds
  ADD COLUMN IF NOT EXISTS refund_notification_sent_at         timestamptz,
  ADD COLUMN IF NOT EXISTS refund_settled_notification_sent_at timestamptz;

COMMENT ON COLUMN public.refunds.refund_notification_sent_at IS
  'Set when the customer refund-initiated notification email is sent. Session 28a.';

COMMENT ON COLUMN public.refunds.refund_settled_notification_sent_at IS
  'Set when the customer refund-settled notification email is sent. Session 28a.';
