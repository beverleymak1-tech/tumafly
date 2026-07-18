# Supabase migrations

SQL migrations for the TumaFly Supabase project (`wmplcauhaqtyenwvkrkq`).

## Convention

Filename: `YYYYMMDDHHMMSS_short_description.sql`. Timestamps are sortable
so migrations apply in lexicographic order.

## Idempotency

Every migration in this directory is idempotent — uses `IF NOT EXISTS`
on tables/columns/indexes, `CREATE OR REPLACE` on functions/triggers.
Safe to replay on any environment.

## History note

Migrations dated `20260101000000` and `20260101000001` are BACKFILLS of
schema that was originally applied ad-hoc via the Supabase SQL Editor
before this directory existed. The timestamps are placeholders that
predate the earliest real migration — they're chosen only to sort
before genuinely-dated files. Do NOT trust them as historical evidence
of when the schema first landed in production.

The first genuinely-dated migration is `20260718120000` (Session 28a).
Everything after that reflects actual application dates.

## Applying migrations

Migrations in this directory are the source of truth for reproducing
the schema on a fresh environment. On production they are applied via
the Supabase SQL Editor as part of session workflows; on branch/local
databases they can be applied via `supabase db push` after linking.
