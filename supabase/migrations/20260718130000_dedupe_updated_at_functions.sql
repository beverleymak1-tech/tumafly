-- Session 28b #1: dedupe redundant updated_at trigger functions in public schema.
--
-- Prior state of custom (non-Supabase-owned) functions:
--   1. public.trigger_set_updated_at()   — used by pending_bookings (canonical)
--   2. public.refunds_touch_updated_at() — used by refunds only (redundant)
--
-- After this migration:
--   - refunds trigger uses trigger_set_updated_at() (matches pending_bookings)
--   - refunds_touch_updated_at() dropped
--
-- Note: storage.update_updated_at_column() is a Supabase-owned platform
-- function used internally by the storage schema. We do NOT touch it —
-- dropping it would break the storage layer.
--
-- Behavior unchanged: both functions did `NEW.updated_at = now()`. This
-- is purely a consolidation, not a functional change.

CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refunds_updated_at ON public.refunds;

CREATE TRIGGER refunds_updated_at
  BEFORE UPDATE ON public.refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

DROP FUNCTION IF EXISTS public.refunds_touch_updated_at();
