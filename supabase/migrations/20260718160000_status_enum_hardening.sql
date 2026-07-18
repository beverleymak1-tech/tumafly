-- Session 28b #5: status enum hardening + audit trail.
--
-- Converts pending_bookings.status and bookings.status from plain text
-- to Postgres enum types to eliminate the class of silent-accept bug
-- Session 27 hit (QX3QVO briefly had status='confirmed', an illegal
-- value silently accepted because text has no domain constraints).
--
-- Also lands three pieces of substrate the async decoupling needs:
--   - New states in pending_booking_status: duffel_pending, pnr_issued
--     for the two-milestone Duffel decoupling (Session 28b architecture).
--   - Missing updated_at column on bookings (audit gap).
--   - booking_status_history table + triggers for full transition audit.
--
-- Enum values reflect ACTUAL production usage (verified via grep across
-- supabase/functions/ + frontend/index.html and DISTINCT status queries
-- at commit open):
--   - paid_offer_expired: written by mpesa-callback, pesapal-webhook,
--     retry-stuck-bookings, paystack-webhook.
--   - failed_to_create: written by create-payment and initialize-payment.
--   - booking: retained as backwards-compat during migration per Q5
--     answer at session open; new code MUST NOT write it.
--
-- Three dependencies on the text type had to be handled explicitly:
--   1. pending_bookings.status has DEFAULT 'pending'::text.
--      Postgres refuses to auto-cast column defaults during ALTER TYPE.
--      Fix: DROP DEFAULT, ALTER TYPE, SET DEFAULT under the enum type.
--   2. bookings.status has DEFAULT 'confirmed'::text — same treatment.
--   3. idx_pending_bookings_stuck is a partial index with
--      WHERE status = ANY (ARRAY['paid'::text, 'booking'::text]).
--      Postgres refuses to auto-cast partial-index predicates during
--      ALTER TYPE. Fix: DROP INDEX, ALTER TYPE, recreate the index
--      using enum values. Also expand its WHERE clause to cover the
--      new async states (duffel_pending, pnr_issued) so the
--      retry-stuck-bookings sweeper stays efficient once §7.5's
--      changes ship in commit #9.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pending_booking_status') THEN
    CREATE TYPE public.pending_booking_status AS ENUM (
      'pending',
      'paid',
      'booking',
      'duffel_pending',
      'pnr_issued',
      'booked',
      'paid_booking_failed',
      'paid_offer_expired',
      'failed_to_create',
      'refund_pending',
      'refunded'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_status') THEN
    CREATE TYPE public.booking_status AS ENUM (
      'confirmed',
      'cancelled',
      'refund_pending',
      'refunded',
      'paid_booking_failed'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pending_bookings'
        AND column_name = 'status') = 'text' THEN
    DROP INDEX IF EXISTS public.idx_pending_bookings_stuck;
    ALTER TABLE public.pending_bookings ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.pending_bookings
      ALTER COLUMN status TYPE public.pending_booking_status
      USING status::public.pending_booking_status;
    ALTER TABLE public.pending_bookings
      ALTER COLUMN status SET DEFAULT 'pending'::public.pending_booking_status;
    CREATE INDEX IF NOT EXISTS idx_pending_bookings_stuck
      ON public.pending_bookings (status, updated_at)
      WHERE status IN ('paid', 'booking', 'duffel_pending', 'pnr_issued');
  END IF;

  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bookings'
        AND column_name = 'status') = 'text' THEN
    ALTER TABLE public.bookings ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.bookings
      ALTER COLUMN status TYPE public.booking_status
      USING status::public.booking_status;
    ALTER TABLE public.bookings
      ALTER COLUMN status SET DEFAULT 'confirmed'::public.booking_status;
  END IF;
END $$;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS set_updated_at ON public.bookings;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS public.booking_status_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL,
  booking_table  text NOT NULL CHECK (booking_table IN ('bookings', 'pending_bookings')),
  from_status    text,
  to_status      text NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     text,
  reason         text
);

CREATE INDEX IF NOT EXISTS booking_status_history_lookup
  ON public.booking_status_history (booking_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS booking_status_history_recent
  ON public.booking_status_history (changed_at DESC);

CREATE OR REPLACE FUNCTION public.log_booking_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status)
     OR TG_OP = 'INSERT' THEN
    INSERT INTO public.booking_status_history (
      booking_id,
      booking_table,
      from_status,
      to_status
    ) VALUES (
      NEW.id,
      TG_TABLE_NAME,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text ELSE NULL END,
      NEW.status::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS log_status_change ON public.pending_bookings;
CREATE TRIGGER log_status_change
  AFTER INSERT OR UPDATE OF status ON public.pending_bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.log_booking_status_change();

DROP TRIGGER IF EXISTS log_status_change ON public.bookings;
CREATE TRIGGER log_status_change
  AFTER INSERT OR UPDATE OF status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.log_booking_status_change();
