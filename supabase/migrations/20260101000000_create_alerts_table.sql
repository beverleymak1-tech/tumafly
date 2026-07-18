-- Backfill: alerts table.
-- Originally created ad-hoc via SQL Editor prior to Session 28b.
-- Stores operational alerts raised by EFs (PAID_NO_TICKET, PAID_NO_OFFER,
-- BOOKED_NO_DB_RECORD, REFUND_EVENT_NO_ROW, etc.) and their delivery status.

CREATE TABLE IF NOT EXISTS public.alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type    text NOT NULL,
  severity      text NOT NULL,
  context       jsonb NOT NULL,
  sent_to       text NOT NULL,
  email_id      text,
  email_status  text,
  resolved      boolean DEFAULT false,
  resolved_at   timestamptz,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_type
  ON public.alerts USING btree (alert_type);

CREATE INDEX IF NOT EXISTS idx_alerts_unresolved
  ON public.alerts USING btree (created_at DESC)
  WHERE (resolved = false);
