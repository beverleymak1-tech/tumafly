-- Session S-06 migration: add chargeback lifecycle states to booking_status enum.
-- Ships with S-06 (chargeback / dispute webhook handler).
-- Safe to re-run — IF NOT EXISTS ignores values already present.
--
-- Postgres note: ALTER TYPE ADD VALUE cannot run inside a transaction that has
-- already used the type. If wrapping this in BEGIN/COMMIT fails, run each
-- ALTER separately (they are inherently idempotent).

ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'disputed';
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'chargeback_won';
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'chargeback_lost';
