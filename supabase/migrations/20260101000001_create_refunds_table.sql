-- Backfill: refunds table.
-- Originally created ad-hoc via SQL Editor as part of Batch 2 (auto-refund
-- on paid_booking_failed / paid_offer_expired) prior to Session 28b.
--
-- Depends on public.pending_bookings existing (not in this backfill —
-- assumed pre-existing).

CREATE TABLE IF NOT EXISTS public.refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_booking_id   uuid NOT NULL
                       REFERENCES public.pending_bookings(id)
                       ON DELETE RESTRICT,
  merchant_ref         text NOT NULL,
  paystack_tx_id       text NOT NULL,
  paystack_refund_id   text,
  amount_kes           numeric NOT NULL,
  reason               text NOT NULL,
  status               text NOT NULL DEFAULT 'pending',
  customer_email       text,
  paystack_error       jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refunds_merchant_ref_idx
  ON public.refunds USING btree (merchant_ref);

CREATE INDEX IF NOT EXISTS refunds_paystack_refund_id_idx
  ON public.refunds USING btree (paystack_refund_id);

CREATE UNIQUE INDEX IF NOT EXISTS refunds_paystack_tx_id_uniq
  ON public.refunds USING btree (paystack_tx_id);
