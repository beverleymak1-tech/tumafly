-- Session 28c commit #10d (Artifact 1 of 2)
-- Enable Realtime replication on the three tables the #success page
-- needs to subscribe to.
--
-- Postgres publications tell the WAL decoder which tables' changes to
-- stream. Supabase Realtime subscribes to the `supabase_realtime`
-- publication and forwards changes it sees to connected clients,
-- subject to RLS on the client's JWT.
--
-- Guest clients arrive with a JWT minted by mint-guest-token (#10c)
-- carrying role=authenticated and guest_pending_booking_id=<uuid>.
-- The RLS policies from #10b then restrict visibility to their own row.
--
-- Idempotent: DO block checks pg_publication_tables before each ADD.
-- Re-runnable.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pending_bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_bookings;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bookings;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'booking_status_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.booking_status_history;
  END IF;
END $$;
