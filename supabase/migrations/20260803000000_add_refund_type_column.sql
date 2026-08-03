-- Session 29 §4.3 — add refund_type column to distinguish automatic vs manual refunds
--
-- Purpose: the frontend refund details card (Session 29) needs to show
-- an "automatic" vs "manual" indicator. Existing 19 refunds in production
-- are all automatic (fired by paid_booking_failed / paid_offer_expired
-- auto-refund path). Ops-initiated manual refunds — customer service
-- goodwill, chargeback response, other — need distinguishing so the
-- frontend copy can say "This refund was processed by our support team."
--
-- Non-breaking: DEFAULT 'automatic' backfills all 19 existing rows correctly.
-- Any future manual-refund entry point (customer-service tooling, ops
-- dashboard) must set refund_type='manual' at insert time.
--
-- Applied against production via SQL Editor Aug 3, 2026; this migration
-- file backfills for durability against fresh envs / re-provisions.
-- Idempotent (IF NOT EXISTS guard) — safe no-op on any env where the
-- column already exists.

ALTER TABLE public.refunds
  ADD COLUMN IF NOT EXISTS refund_type text
  NOT NULL
  DEFAULT 'automatic'
  CHECK (refund_type IN ('automatic', 'manual'));

NOTIFY pgrst, 'reload schema';
