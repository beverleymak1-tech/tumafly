-- Session 48 · Duffel-webhook redesign: EAGER-capture event stream
-- Spec: claude/TumaFly_Session47_DesignSpec_DuffelWebhookRedesign.md section 2.2
-- Pattern: durable local source of truth independent of app state machine.
--   duffel-webhook EF UPSERTs here BEFORE dispatch (eager capture).
--   Session 49 reconciler Sweeps R1 + R2 read this table (deferred).
-- RLS pattern mirrors audit_log: service role only, no authenticated access.

CREATE TABLE public.duffel_webhook_events (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             text         NOT NULL,
  event_type           text         NOT NULL,
  event_created_at     timestamptz  NOT NULL,
  received_at          timestamptz  NOT NULL DEFAULT now(),
  live_mode            boolean      NOT NULL,
  duffel_order_id      text         NULL,
  payload              jsonb        NOT NULL,
  processed_at         timestamptz  NULL,
  processing_outcome   text         NULL,
  processing_error     text         NULL,
  pending_booking_id   uuid         NULL REFERENCES public.pending_bookings(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX duffel_webhook_events_event_id_uniq
  ON public.duffel_webhook_events (event_id);

CREATE INDEX duffel_webhook_events_unprocessed_idx
  ON public.duffel_webhook_events (received_at ASC)
  WHERE processed_at IS NULL;

CREATE INDEX duffel_webhook_events_order_id_idx
  ON public.duffel_webhook_events (duffel_order_id)
  WHERE duffel_order_id IS NOT NULL;

CREATE INDEX duffel_webhook_events_received_at_idx
  ON public.duffel_webhook_events (received_at DESC);

ALTER TABLE public.duffel_webhook_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.duffel_webhook_events IS
  'Authoritative local source of truth for Duffel webhook events. Eager-captured on arrival by duffel-webhook EF before dispatch (Session 48). Reconciler Sweeps R1 and R2 (Session 49) read this table to detect stuck bookings vs genuine external orders. Spec: claude/TumaFly_Session47_DesignSpec_DuffelWebhookRedesign.md section 2.2.';

COMMENT ON COLUMN public.duffel_webhook_events.event_id IS
  'Duffel event.id. UNIQUE enforces replay idempotency across Duffel + DB-webhook retries. Fallback to composite (idempotency_key, event_type) documented in spec section 2.2.a.';

COMMENT ON COLUMN public.duffel_webhook_events.processed_at IS
  'NULL until inline handler or reconciler marks processed. Reconciler Sweep R1 scan predicate (partial index duffel_webhook_events_unprocessed_idx).';

COMMENT ON COLUMN public.duffel_webhook_events.processing_outcome IS
  'Enum (not CHECK-constrained to allow forward-compat additions): handled_inline | race_resolved | external_order | failed | noop. See spec section 2.3 handler pseudocode.';

COMMENT ON COLUMN public.duffel_webhook_events.pending_booking_id IS
  'Set by inline handler or reconciler once resolution succeeds. ON DELETE SET NULL preserves forensic trail even if pending_bookings row is purged later.';
