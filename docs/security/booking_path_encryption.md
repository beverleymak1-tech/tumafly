# TumaFly Booking-Path Column Encryption

**Domain:** Postgres column-level encryption for sensitive personal data on the active-booking data path — `public.pending_bookings.passengers`, `public.bookings.passenger_name / passenger_email / passenger_phone`, and `public.bookings.passenger_details`. Also captures the S-14c extension of `public.saved_travelers` to add name fields to the previously-shipped Session 36 encryption set.

**Owner:** Backend engineer with security ownership (currently: Founder)

**Regulatory alignment:**
- Kenya Data Protection Act 2019 §§25, 41, 44 — technical and organisational measures for protecting personal data, with heightened protection for special-category data
- Duffel KYC 1.15 / 2.14 — encryption of sensitive passenger data at rest
- ODPC portal filing — Personal Data + Sensitive Data tabs cite this document

**Introduced:** Session S-14b + S-14c (2026-09-06)

**Pattern extends:** `docs/security/saved_travelers_encryption.md` (Session 36, 2026-08-19) — the pgcrypto column-encryption pattern shipped for the profile store, now extended to cover both the profile store extension (4 additional name columns) and the active-booking data path (3 tables).

**Session close:** this document.

---

## 1. Purpose and scope

### 1.1 What this encryption covers

Sensitive personal data on three tables holding the same customer's information at different lifecycle stages:

- **`saved_travelers`** — user-saved passenger profiles for reuse across bookings. Session 36 shipped encryption of 10 columns; S-14c extends to 14 columns (adds `title`, `given_name`, `family_name`, `middle_name`).
- **`pending_bookings.passengers`** — JSONB array of passenger objects for an in-flight booking, from Continue-to-Payment click through Duffel order creation.
- **`bookings`** — completed booking records with post-ticketing itinerary detail and passenger information rendered on the customer's `#my-trips` view and confirmation email.

The encryption footprint is designed so that the same customer's `given_name` (as an example) is encrypted at rest in every table that holds it, regardless of which lifecycle stage the row represents. This gives one unified encryption story defensible to ODPC, Duffel Compliance, and any future subject-access request.

### 1.2 The 3-table encryption footprint after S-14b + S-14c

**`saved_travelers`** — 14 columns encrypted (10 shipped Session 36 + 4 added by S-14c):

- Shipped Session 36 (S-14): `passport_number`, `born_on`, `nationality`, `passport_expires`, `passport_country`, `gender`, `special_assistance`, `known_traveler_id`, `redress_number`, `frequent_flyer`
- Added by S-14c: `title`, `given_name`, `family_name`, `middle_name`

**`pending_bookings.passengers`** — 14 sensitive fields encrypted in place within the JSONB array structure (S-14b):

- Top-level per passenger: `title`, `gender`, `given_name`, `family_name`, `middle_name`, `born_on`, `nationality`, `known_traveler_id`, `redress_number`, `special_assistance`, `loyalty_programme_accounts`
- Nested per `identity_documents[]` element: `unique_identifier`, `expires_on`, `issuing_country_code`

Each encrypted passenger object is stamped with `_pii_encrypted: true, _pii_version: 1` markers for trigger idempotency and downstream verification.

**Passthrough (intentionally plaintext) fields within `pending_bookings.passengers`:**

- `type` — passenger classification (adult / child / infant_without_seat); needed for Duffel routing and for infant-to-adult pairing at `/air/orders`
- `id` — Duffel passenger reference (`pas_xxx`); needed for offer-to-order mapping
- `identity_documents[].type` — document classification (passport / national_id); non-sensitive metadata

**`bookings`** — 3 flat columns encrypted (S-14b):

- `passenger_name` (comma-joined name of all passengers as a single string, rendered on `#my-trips` cards)
- `passenger_email` (contact email, rendered on itinerary detail view and confirmation-email routing)
- `passenger_phone` (contact phone, rendered on itinerary detail view)

**`bookings.passenger_details`** — 2 fields encrypted in place within the JSONB array (S-14b):

- Per-passenger element: `name`
- Per-segment element: `ticket` (airline e-ticket identifier; encrypted for defense-in-depth — a ticket number + PNR pair enables self-service on some airline websites)

**Passthrough fields within `bookings.passenger_details`:**

- Per-passenger: `type` (adult / child / infant)
- Per-segment: `seat`, `flight`, `origin`, `destination`, `carrier` — itinerary metadata, not personal data

### 1.3 Intentionally NOT encrypted (documented rationale)

Certain personal-data fields are held in plaintext under complementary controls rather than encrypted:

- **`pending_bookings.contact`** (`email`, `phone_number`) — contact data, personal data but not §44 special-category. Protected by RLS deny-all + volume-encryption + TLS. Note: where the same customer's contact data flows through to `bookings.passenger_email / passenger_phone` (a live read path served to the signed-in `#my-trips` view), the destination columns ARE encrypted. This gives belt-and-braces coverage on the customer-visible read path without adding unnecessary decrypt overhead to the transactional-store read path.
- **`bookings.etims_receipt_number`, `etims_qr_code_url`, `etims_status`, `etims_issued_at`** — Kenya Revenue Authority e-TIMS tax audit artefacts. Plaintext retention is a KRA-accessibility decision.
- **`bookings.mpesa_receipt_number`** — Safaricom-issued receipt reference. Not personal data.

Encrypted-at-rest coverage is complemented by:

1. Supabase-managed volume-level encryption on the underlying storage
2. TLS 1.3 in transit between the application and the database, and between the application and all third-party service providers (Duffel, Paystack, Africa's Talking, Resend)
3. Row-Level Security deny-all-by-default policies on the underlying tables with service-role bypass only
4. The `service_role` credential is restricted to backend Edge Functions and scheduled `pg_cron` jobs; no customer, anonymous, or ordinary authenticated database connection can read across records on these tables

---

## 2. Configuration — Vault key, wrapper functions, JSONB walkers

### 2.1 Vault-stored key

The encryption passphrase is stored in Supabase Vault:

- **Name:** `saved_travelers_encryption_v1`
- **Vault secret ID:** `03b9ffa5-abdf-41e9-8796-5f1ec58ff6a7`
- **Format:** base64-encoded 256 random bits (~44 chars), generated via `gen_random_bytes(32)`
- **Introduced:** Session 36 (2026-08-19)
- **Reused by S-14b:** the same passphrase and Vault key covers all three tables. The version number is on the key, not the table. Single-story simplicity beats separate-key theoretical blast-radius reduction — both keys would sit within the same Vault trust boundary anyway.

**Access:** the passphrase never enters the Edge Function runtime environment. It lives entirely inside Postgres (Vault) and is accessible only via `SELECT decrypted_secret FROM vault.decrypted_secrets` from roles with Vault SELECT (postgres, service_role). The `authenticated` and `anon` roles cannot read it directly; they call it indirectly via `SECURITY DEFINER` wrapper functions.

### 2.2 String-level wrapper functions (Session 36)

Two wrappers, unchanged from Session 36:

- **`public.encrypt_saved_traveler_field(plaintext text) → bytea`** — takes plaintext, returns pgcrypto PGP-symmetric ciphertext as `bytea`
- **`public.decrypt_saved_traveler_field(ciphertext bytea) → text`** — takes ciphertext, returns plaintext

Both functions are:

- `SECURITY DEFINER` (bypass RLS to reach the Vault secret)
- `STRICT` (return NULL on NULL input; do not decrypt/encrypt NULL)
- `STABLE` (safe for use in views without re-execution per row)
- `SET search_path = extensions, public` (pinned; prevents search-path attacks)

**Grants:** `GRANT EXECUTE TO authenticated, service_role; REVOKE ALL FROM anon;` (explicit revocation for defence-in-depth against future PostgREST configuration drift)

**Cosmetic note (deferred):** the wrapper functions are named `_saved_traveler_` but are general-purpose. S-14b uses them verbatim for the booking-path encryption. Renaming to `encrypt_pii_field` / `decrypt_pii_field` is polish for a later dedicated commit — touches shipped surface for no functional gain.

### 2.3 JSONB walker functions (S-14b, new)

Two pairs of walker functions for the JSONB paths, added by S-14b:

**`public.encrypt_passenger_pii(passengers_in jsonb) → jsonb`** — walks a `pending_bookings.passengers` array, encrypts the 14 sensitive fields per passenger + the 3 nested fields per `identity_documents[]` element. Serialises `loyalty_programme_accounts` array-of-objects as a JSON string, encrypts as one ciphertext blob (mirrors the `saved_travelers.frequent_flyer` pattern from Session 36). Stamps `_pii_encrypted: true, _pii_version: 1` on each passenger object.

**`public.decrypt_passenger_pii(passengers_in jsonb) → jsonb`** — symmetric reverse. Strips `_pii_encrypted` and `_pii_version` markers before returning. Deserialises `loyalty_programme_accounts` from JSON string back to array-of-objects.

**`public.encrypt_booking_display_pii(details_in jsonb) → jsonb`** — narrower shape for `bookings.passenger_details`. Encrypts per-passenger `name` and per-segment `ticket`. Stamps `_pii_encrypted: true, _pii_version: 1`.

**`public.decrypt_booking_display_pii(details_in jsonb) → jsonb`** — symmetric reverse.

**Idempotency guards** on both encrypt-side functions: if the first passenger element already carries `_pii_encrypted`, return unchanged. On both decrypt-side functions: if the marker is NOT present, treat as already-plaintext and return unchanged (allows the view to handle transitional row states during backfill without crashing).

**All four walkers:** `SECURITY DEFINER`, `STABLE`, `SET search_path = extensions, public`. `REVOKE ALL FROM public, anon; GRANT EXECUTE TO authenticated, service_role.`

### 2.4 Trigger functions (BEFORE INSERT/UPDATE encrypt-on-write)

**`public.encrypt_pending_bookings_trigger()`** — fires on INSERT and on UPDATE OF `passengers`. Calls `encrypt_passenger_pii(NEW.passengers)` if `passengers` is non-null and (on UPDATE) distinct from OLD.

**`public.encrypt_bookings_trigger()`** — fires on INSERT and on UPDATE OF `passenger_name`, `passenger_email`, `passenger_phone`, `passenger_details`. Encrypts each flat column and the JSONB via `encrypt_booking_display_pii`. Uses the `NOT LIKE 'ww0EBwMC%'` idempotency check to prevent double-encryption on backfill-style UPDATEs.

**`public.encrypt_saved_traveler_columns()`** (extended by S-14c) — original Session 36 trigger, now covering 14 columns instead of 10. Extended with 4 additional per-column `NEW IS DISTINCT FROM OLD` IF blocks for `title`, `given_name`, `family_name`, `middle_name`.

### 2.5 Decrypted views (`security_invoker = true`)

**`public.pending_bookings_decrypted`** — full column projection over `pending_bookings`, with `decrypt_passenger_pii(passengers)` replacing the raw `passengers` column. All other columns pass through unchanged (including `contact` which is plaintext by design).

**`public.bookings_decrypted`** — full column projection over `bookings`, with:
- `CASE WHEN passenger_name IS NULL THEN NULL ELSE decrypt_saved_traveler_field(decode(passenger_name, 'base64')) END` for each of the 3 flat encrypted columns
- `decrypt_booking_display_pii(passenger_details)` for the JSONB

**`public.saved_travelers_decrypted`** (extended by S-14c) — original Session 36 view, extended to decrypt the 4 additional name columns via the same `decrypt_saved_traveler_field(decode(col, 'base64'))` pattern.

**`security_invoker = true`** on all three views means the underlying RLS applies to the caller reading through the view — the view is not a bypass mechanism. A guest-JWT caller reading through the view still gets RLS-filtered results as configured on the raw table.

**Grants:** `GRANT SELECT ON <view> TO authenticated, service_role.`

---

## 3. Deployment record

### 3.1 Session S-14b / S-14c commit topology

Three commits landed on the coding side:

- `2c224de` — `feat(security): S-14b booking-path encryption + S-14c saved_travelers name-field extension` — the three SQL migrations
- `5fbbbb4` — `feat(security): S-14b EF read-path view swaps + Session 28e-10.7 rename cleanup + polish` — 13 Edge Function files, view swaps + surfaced polish items
- `431772f` — `chore(config): register heartbeat EF verify_jwt=false (S39 leftover)` — Session 39 cleanup that opened the S-14b session

### 3.2 SQL migration files

Three migration files at `supabase/migrations/`:

- `session_s14b_01_snapshots.sql` — creates the three pre-migration snapshot tables (`pending_bookings_pre_s14b_backup`, `bookings_pre_s14b_backup`, `saved_travelers_pre_s14c_backup`) with `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL FROM anon, authenticated` to preserve service-role-only access
- `session_s14b_02_helpers_triggers_views.sql` — the four JSONB walker functions + two new trigger functions + two new views + grants
- `session_s14c_01_trigger_view_extension.sql` — extended `encrypt_saved_traveler_columns` trigger function + extended `saved_travelers_decrypted` view + backfill via snapshot restore

### 3.3 EF read-path swaps (12 total across 8 EFs)

Every Edge Function that reads passenger data now flows through the decrypted views:

| EF | Site | View swapped to |
|---|---|---|
| `mpesa-callback` | line 121 | `pending_bookings_decrypted` |
| `paystack-webhook` | line 495 | `pending_bookings_decrypted` |
| `process-duffel-booking` | line 150 | `pending_bookings_decrypted` — critical for Duffel `/air/orders` payload correctness |
| `duffel-webhook` | line 135 (helper) | `pending_bookings_decrypted` |
| `retry-stuck-bookings` | 4 sweep queries | `pending_bookings_decrypted` |
| `payment-status` | lines 111, 158, 176 | `bookings_decrypted` (Mode C PNR lookup), `pending_bookings_decrypted` (Mode A polling), `bookings_decrypted` (booked-state join) |
| `get-user-trips` | lines 51, 105 | `bookings_decrypted` (main SELECT), `pending_bookings_decrypted` (KES enrichment) |
| `send-refund-notification` | line 300 | `pending_bookings_decrypted` |

Write paths (`INSERT`, `UPDATE`, `UPSERT`, `DELETE`) remain on the raw tables — the triggers handle encryption on write.

### 3.4 Frontend impact

**Verified zero-impact.** Grep of `frontend/index.html` (24,292 lines) confirms:

- Zero `sb.from('pending_bookings')` calls
- Zero `sb.from('bookings')` calls
- `sb.from('saved_travelers')` — 3 upsert/delete sites (writes; trigger handles encryption)
- `sb.from('saved_travelers_decrypted')` — 1 read site at `fetchSavedTravelers` (already reads from view since Session 36)

The 4 new columns added to the `saved_travelers_decrypted` view by S-14c flow through unchanged. No frontend commit needed for either S-14b or S-14c.

### 3.5 Pre-migration snapshots

Three snapshot tables were created at Chunk A of the session:

- `public.pending_bookings_pre_s14b_backup` (198 rows)
- `public.bookings_pre_s14b_backup` (151 rows)
- `public.saved_travelers_pre_s14c_backup` (1 row)

**Retention:** 30 days from application per Session 35b Decision 5. **DROP scheduled:** 2026-10-06.

**Access posture:** all three snapshots are RLS-enabled with zero policies attached and all PostgREST-visible grants explicitly revoked from `anon` + `authenticated`. Deny-all-by-default; service-role-only via bypass. Volume-level encryption applies. This matches the access posture of the source tables.

### 3.6 Verification landed at close

**Round-trip proven on real data via new customer booking flow.** A live end-to-end booking (PNR `OITGDT`) was completed post-deploy against Duffel sandbox + Paystack test mode. Verified:

- Raw `pending_bookings.passengers` shows base64 ciphertext starting `ww0EBwMC...` on the new row's `given_name`
- Raw `bookings.passenger_name`, `passenger_email`, `passenger_phone` all show ciphertext
- Raw `bookings.passenger_details` shows `_pii_encrypted: true` marker on the first element
- Read through `pending_bookings_decrypted` yields plaintext `"Beverley Makhubele"`
- Read through `bookings_decrypted` yields plaintext across all encrypted columns
- Confirmation email arrived with correctly-decrypted passenger name in the eTicket body
- Duffel `/air/orders` accepted the decrypted-view-fed passenger payload cleanly (no schema-validation errors on `born_on`, `gender`, `nationality`, `identity_documents`)

**Synthetic INSERT round-trip on `saved_travelers`** also proven post-S-14c backfill — new row's raw `title`, `given_name`, `family_name`, `middle_name` all show ciphertext; read through `saved_travelers_decrypted` yields plaintext across all 14 encrypted columns.

---

## 4. Backfill notes

### 4.1 S-14b backfill (both booking tables)

Executed as separate UPDATE statements per table, run outside a wrapping `BEGIN`/`COMMIT` (Supabase SQL Editor was found to auto-commit statement-by-statement, making explicit BEGIN/ROLLBACK unreliable in that environment; the pre-migration snapshots provide the rollback path).

**`pending_bookings.passengers`:**

```sql
UPDATE public.pending_bookings
SET passengers = public.encrypt_passenger_pii(passengers)
WHERE passengers IS NOT NULL
  AND jsonb_array_length(passengers) > 0
  AND NOT ((passengers->0) ? '_pii_encrypted');
```

Idempotency: the encrypt walker's early-return-on-marker check means re-running is safe.

Result: 198/198 rows encrypted.

**`bookings` flat columns and `passenger_details`:**

Two UPDATE statements — flat columns via `CASE WHEN NOT LIKE 'ww0EBwMC%'` guard, then `passenger_details` via marker-based idempotency.

Result: 151/151 names encrypted, 151/151 emails encrypted, 151/151 phones encrypted, 132/132 passenger_details encrypted.

### 4.2 S-14c backfill (saved_travelers name columns)

**The naive backfill pattern hit a double-encryption bug that was recovered via snapshot restore.** This is documented because the migration file's backfill shape encodes the correction, and future replay scenarios must use the correct pattern.

**What was tried first (WRONG):**

```sql
UPDATE public.saved_travelers
SET
  given_name = encode(public.encrypt_saved_traveler_field(given_name), 'base64'),
  ... (same for title, family_name, middle_name)
WHERE ...;
```

This double-encrypted every affected column: the SET expression encrypted plaintext → ciphertext-A, then the extended trigger (installed in the prior step) fired on the UPDATE, saw `NEW.given_name IS DISTINCT FROM OLD.given_name`, and encrypted ciphertext-A → ciphertext-B. Reading through the view then yielded ciphertext-A (single-decrypt of ciphertext-B) instead of plaintext.

**Recovery pattern (CORRECT — encoded in the migration file):**

```sql
UPDATE public.saved_travelers st
SET
  title       = bk.title,
  given_name  = bk.given_name,
  family_name = bk.family_name,
  middle_name = bk.middle_name
FROM public.saved_travelers_pre_s14c_backup bk
WHERE st.id = bk.id;
```

The `FROM saved_travelers_pre_s14c_backup` provides plaintext values (the snapshot was taken before the trigger extension), and the trigger correctly encrypts on write. One trigger fire, one encryption pass, one clean single-encryption per row.

**Why this pattern works and the encode-in-SET pattern doesn't:**

The Session 36 trigger uses `NEW IS DISTINCT FROM OLD` as its idempotency guard. That guard was designed to skip trigger execution on passthrough UPDATEs where the value isn't changing. It correctly skips encryption on `UPDATE saved_travelers SET some_other_column = ... WHERE ...`, where `given_name` was passed through unchanged. But it does NOT prevent double-encryption when the SET expression itself computes a different (encrypted) value than OLD.

For future retroactive extensions of the encryption footprint, the two viable patterns are:

1. **Snapshot-restore + let-trigger-encrypt** (chosen here). Requires a plaintext source of the truth (snapshot table).
2. **Disable trigger during backfill.** `ALTER TABLE ... DISABLE TRIGGER ...` around the backfill UPDATE. Slightly more moving parts but doesn't require a snapshot dependency.

The migration file uses pattern 1. When the S-14c snapshot is dropped at the 30-day retention window, the migration becomes unreplayable in its current form. This is documented behaviour: the migration exists as a git audit trail of what ran against production, not as a replay artefact for arbitrary future environments. A dev environment rebuilding from scratch would either skip the S-14c backfill (columns don't need historical encryption there) or add plaintext test data and re-run the extended trigger's INSERT path.

### 4.3 Handoff drift documented

Several deviations between the S-14b handoff document and actual DB state were surfaced during execution:

- **Trigger function name:** handoff assumed `encrypt_saved_traveler_fields`; actual name is `encrypt_saved_traveler_columns`. Migration file uses the actual name.
- **`pending_bookings` schema:** handoff enumerated ~15 columns; actual table has 27 columns (`mpesa_checkout_request_id` where handoff had `mpesa_checkout_id`, plus 8 additional Daraja + confirmation-lifecycle columns). Views rebuilt against actual `information_schema.columns` output.
- **`bookings` schema:** all 44 columns present in the handoff's assumed set; column ordering slightly different. Not fatal — view SELECT lists don't need to match table ordinal position.
- **Session 39 snapshot drop:** the Session 36 `saved_travelers_pre_s14_backup` table was dropped on 2026-09-04 per its 30-day retention (Session 39 commit `f0e239c`). S-14c took a fresh `saved_travelers_pre_s14c_backup` unconditionally, which turned out to be the recovery vehicle for the double-encryption bug in §4.2.

---

## 5. Rollback procedures

Three progressive levels of rollback, in order of increasing severity.

### 5.1 Level 1 — disable a trigger (transitional state, EFs return ciphertext)

If a trigger is misbehaving in production but the data itself is fine:

```sql
DROP TRIGGER pending_bookings_encrypt_passengers ON public.pending_bookings;
DROP TRIGGER bookings_encrypt_pii ON public.bookings;
-- or for the Session 36 + S-14c trigger:
DROP TRIGGER saved_travelers_encrypt ON public.saved_travelers;
```

Views can stay — the walker functions handle both encrypted-and-plaintext row states via marker checks. Future INSERTs and UPDATEs land plaintext; existing encrypted rows continue to decrypt on read.

Reversible: re-run the trigger CREATE from the migration file.

### 5.2 Level 2 — full snapshot restore (loses writes since snapshot)

If data corruption is suspected on either booking table:

```sql
-- Verify snapshot integrity first
SELECT COUNT(*) FROM public.pending_bookings_pre_s14b_backup;
SELECT COUNT(*) FROM public.bookings_pre_s14b_backup;
SELECT COUNT(*) FROM public.saved_travelers_pre_s14c_backup;

-- Restore. WARNING: TRUNCATE cascades to booking_status_history via FK.
-- Read the FK topology before running.
TRUNCATE public.pending_bookings CASCADE;
INSERT INTO public.pending_bookings SELECT * FROM public.pending_bookings_pre_s14b_backup;

-- Same shape for bookings + saved_travelers if needed.
```

**Reversible only until the 30-day snapshot drop.** After 2026-10-06 the snapshot tables no longer exist.

**⚠ CASCADE will affect `booking_status_history` FKs.** If FK cascade is unacceptable, do a row-by-row UPDATE from snapshot instead of TRUNCATE + INSERT.

### 5.3 Level 3 — Vault key rotation (existing rows become undecryptable)

Only applicable if the key itself is compromised. Requires:

1. Take a fresh snapshot of every encrypted-column table
2. Decrypt everything to plaintext via `decrypt_saved_traveler_field`
3. Generate a new Vault secret `saved_travelers_encryption_v2`
4. Update wrapper functions to read the new secret name
5. Re-encrypt everything under the new key
6. Retire the old Vault secret

Documented in `TumaFly_SOP_Master.md` §1.5 (rotation procedures). Zero traffic pre-launch makes this significantly easier to execute cleanly; post-launch requires a maintenance window.

---

## 6. Known limitations and design tradeoffs

### 6.1 Non-deterministic encryption

pgcrypto's PGP-symmetric mode uses a random session key per encryption call. Encrypting the same plaintext twice produces two different ciphertexts. Both decrypt to the same plaintext under the same passphrase.

**Consequences:**

- Cannot query encrypted columns by plaintext value (e.g. `WHERE given_name = 'Beverley'`) — the ciphertext on the row won't match any newly-encrypted candidate.
- Cannot use encrypted columns as unique constraints or in foreign key relationships.
- Cross-row equality checks (deduplication, "find the row with the same passport number as this one") are not possible on encrypted columns without decryption.

**Currently in-scope acceptance:** none of the encrypted columns are used for query-side operations in the current codebase. All lookups are by `id`, `merchant_ref`, `booking_reference`, `duffel_order_id`, `user_id`, `status`, or `duffel_offer_id` — none of which are encrypted. If a future use case requires plaintext-side querying, options are:

1. Move to deterministic encryption (`encrypt_iv`) with a per-column IV
2. Add a plaintext-hash column derived from the encrypted value at write time (cast-index pattern)
3. Decrypt via the `_decrypted` view and filter in application code

Not urgent to solve pre-launch.

### 6.2 Snapshot dependency in the S-14c migration file

The migration file `session_s14c_01_trigger_view_extension.sql` references `saved_travelers_pre_s14c_backup` in its backfill UPDATE. When the snapshot is dropped at the 30-day retention window (2026-10-06), this migration will error if re-run. This is documented, acceptable behaviour: the migration exists as an audit trail, not a general-purpose replay artefact. Section 4.2 above documents the alternative disable-trigger backfill pattern for future retroactive extensions.

### 6.3 The `ww0EBwMC%` prefix check on flat text columns

The `bookings_encrypt_pii` trigger and the S-14c backfill CASE guards use `LIKE 'ww0EBwMC%'` as the "already-encrypted" heuristic. This is the base64 signature of a pgcrypto PGP-symmetric header. If a legitimate plaintext string happens to begin with `ww0EBwMC` (astronomically unlikely for names, emails, and phone numbers), the trigger would treat it as already-encrypted and skip.

**Accepted risk.** The JSONB paths use the marker-key check (`_pii_encrypted`) which is exact.

### 6.4 The `contact` field on `pending_bookings`

`pending_bookings.contact` (`email`, `phone_number`, and post-Session-28e-10.7 also `seats: [...]` and `baggages: [...]`) is intentionally plaintext. Rationale:

- Personal data but not §44 special-category
- RLS deny-all + volume-encryption + TLS is proportionate for contact-level data
- Same-customer data flowing through to `bookings.passenger_email / passenger_phone` IS encrypted at that hop, giving belt-and-braces on the customer-visible read path

Framework Doc §5.2 will document this explicitly. The `contact` field grew beyond its original design (`{email, phone_number}`) during Session 28e-10.7 rename work to also carry `seats` and `baggages` selection data — this design drift is noted in the running-updates log for a future normalisation pass. It does not affect the encryption story.

### 6.5 The `_pii_version: 1` marker on JSONB paths

Currently unused for anything beyond documentation. Reserved for future evolution scenarios:

- Adding a new sensitive field to the encrypted set (increment version + trigger backfills old rows)
- Changing the field-level encryption strategy for a sub-path (e.g. moving `loyalty_programme_accounts` to per-element encryption instead of blob)
- Cross-cutting schema migrations that need to know which rows were encrypted before/after a change

The marker's presence is sufficient for the current use case; the version field earns its weight the first time we need to distinguish generations.

### 6.6 Wrapper function naming misnomer (deferred)

The wrapper functions are named `encrypt_saved_traveler_field` and `decrypt_saved_traveler_field` (Session 36 naming). They are now used across three tables, not just `saved_travelers`. A renaming pass to `encrypt_pii_field` / `decrypt_pii_field` is polish for a later dedicated commit — touches shipped surface, requires updating all migration files + attestation docs, provides no functional gain.

Filed as a running-updates open item for a dedicated cleanup session.

---

## 7. Change management

### 7.1 Rotation cadence

**Annual, first business day of the year.** Rotation re-encrypts every row across all three tables (`saved_travelers`, `pending_bookings`, `bookings`) in a single transaction. At current row count (single digits pre-launch, expected hundreds to low thousands Year 1, tens of thousands Year 2 pessimistic) this is instant to minutes. Revisit rotation architecture if aggregate encrypted-row count grows past ~500k (proactive migration to online-rotation via envelope encryption).

**Off-cycle rotation** available on any indication of key compromise. Vault-stored passphrase is versioned in the key name (`_v1`, `_v2`, …) so envelope-style migration is possible.

**Full rotation procedure:** `TumaFly_SOP_Master.md` §1.5.

### 7.2 Verification cadence

**Post-deploy:** run the round-trip synthetic verification from `TumaFly_SOP_Master.md` §5 (encryption smoke check) — insert a synthetic row across all three tables, read back through views, confirm plaintext, delete synthetic rows.

**Monthly:** ad-hoc smoke — pick a random real booking, read through views, confirm plaintext. Documented in `TumaFly_RUNBOOK_Master.md` §7 (new — added by this session's DocUpdate).

**Annual:** as part of the rotation cadence above, verify the entire encryption topology (Vault key presence, wrapper function presence and callable-via-round-trip, trigger presence, view presence, per-table backfill state) via the audit script `scripts/verify_encryption_topology.sh` (roadmap item 51, not yet built).

### 7.3 Adding new encrypted fields

To extend the encryption footprint to additional fields on an existing table:

1. Take a fresh pre-migration snapshot of the target table
2. Extend the trigger function via `CREATE OR REPLACE FUNCTION` with the additional per-column IF blocks matching the existing `NEW IS DISTINCT FROM OLD` pattern
3. Extend the view via `CREATE OR REPLACE VIEW` with the additional `decrypt_saved_traveler_field(decode(col, 'base64'))` expressions
4. Backfill via snapshot-restore-and-let-trigger-encrypt pattern (see §4.2) OR disable-trigger-around-encode-in-SET pattern
5. Verify round-trip on the extended fields via synthetic INSERT
6. Update this attestation doc (§1.2 field list, §2.5 view spec)
7. Update Framework Doc §5.2 field enumeration
8. Update the migration file naming (`session_sNNa_extension.sql` etc)

### 7.4 Adding a new encrypted table

To extend the pattern to a new table:

1. Take a pre-migration snapshot with RLS + PostgREST grants revoked
2. Decide: reuse the existing wrapper functions (`encrypt_saved_traveler_field`, `decrypt_saved_traveler_field`) OR create table-specific wrappers with a separate Vault secret. The default is reuse — the Session 36 + S-14b architecture reuses one Vault secret across three tables, and the trust boundary argument for per-table keys is defeated by the shared Vault access.
3. Create the new table's trigger function following the `encrypt_bookings_trigger` pattern
4. Create the new `_decrypted` view with `security_invoker = true`
5. Backfill existing rows
6. Update every EF that reads from the raw table to read from the view (grep for `.from('<table>')`)
7. Verify round-trip
8. Update this attestation doc's §1.2 (footprint) and §2.5 (views)
9. Update Framework Doc §5.2

### 7.5 Removing an encrypted field from the footprint

Non-trivial. Requires:

1. Decrypt all rows for the affected column, backup to a snapshot
2. Change the column type back to its original semantic type (if changed for encryption)
3. Update the trigger to skip the column
4. Update the view to pass through unchanged
5. Backfill from snapshot to restore plaintext values
6. Update every EF that reads from the view — verify no plaintext-vs-ciphertext regressions
7. Update this doc + Framework Doc

Should not be done casually. Any field that was ever encrypted was so for a reason (regulatory scope, security review, or defense-in-depth). Un-encrypting requires re-justifying against that original reason.

---

## Appendix A — Quick-reference SQL

### A.1 Verify Vault key present

```sql
SELECT id, name FROM vault.decrypted_secrets
WHERE name = 'saved_travelers_encryption_v1';
-- Expected: 1 row, id = 03b9ffa5-abdf-41e9-8796-5f1ec58ff6a7
```

### A.2 Verify all 6 wrapper functions present

```sql
SELECT proname FROM pg_proc
WHERE proname IN (
  'encrypt_saved_traveler_field', 'decrypt_saved_traveler_field',
  'encrypt_passenger_pii', 'decrypt_passenger_pii',
  'encrypt_booking_display_pii', 'decrypt_booking_display_pii'
) AND pronamespace = 'public'::regnamespace
ORDER BY proname;
-- Expected: 6 rows
```

### A.3 Verify all 3 triggers active

```sql
SELECT tgname, tgrelid::regclass::text AS on_table
FROM pg_trigger
WHERE tgname IN (
  'saved_travelers_encrypt',
  'pending_bookings_encrypt_passengers',
  'bookings_encrypt_pii'
) ORDER BY tgname;
-- Expected: 3 rows
```

### A.4 Verify all 3 views present

```sql
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN ('pending_bookings_decrypted', 'bookings_decrypted', 'saved_travelers_decrypted')
ORDER BY c.relname;
-- Expected: 3 rows
```

### A.5 Verify backfill state across all three tables

```sql
SELECT
  -- saved_travelers
  (SELECT COUNT(*) FROM public.saved_travelers WHERE given_name IS NOT NULL AND given_name LIKE 'ww0EBwMC%') AS st_gn_encrypted,
  (SELECT COUNT(*) FROM public.saved_travelers WHERE given_name IS NOT NULL) AS st_gn_total,
  -- pending_bookings
  (SELECT COUNT(*) FILTER (WHERE (passengers->0) ? '_pii_encrypted') FROM public.pending_bookings) AS pb_encrypted,
  (SELECT COUNT(*) FILTER (WHERE passengers IS NOT NULL AND jsonb_array_length(passengers) > 0) FROM public.pending_bookings) AS pb_total,
  -- bookings
  (SELECT COUNT(*) FILTER (WHERE passenger_name LIKE 'ww0EBwMC%') FROM public.bookings) AS b_name_encrypted,
  (SELECT COUNT(*) FILTER (WHERE passenger_name IS NOT NULL) FROM public.bookings) AS b_name_total;
-- Expected: encrypted = total for every pair
```

### A.6 Verify snapshot integrity (until 2026-10-06 DROP)

```sql
SELECT
  (SELECT COUNT(*) FROM public.pending_bookings_pre_s14b_backup) AS pb_backup_rows,
  (SELECT COUNT(*) FROM public.bookings_pre_s14b_backup) AS b_backup_rows,
  (SELECT COUNT(*) FROM public.saved_travelers_pre_s14c_backup) AS st_backup_rows;
-- Expected: 198, 151, 1 (as-of session close 2026-09-06)
```

### A.7 Drop snapshots at 30-day retention (2026-10-06)

```sql
DROP TABLE public.pending_bookings_pre_s14b_backup;
DROP TABLE public.bookings_pre_s14b_backup;
DROP TABLE public.saved_travelers_pre_s14c_backup;
```

Log the DROP in the running-updates log at that time. Do NOT drop earlier — the 30-day window is the rollback runway.

---

*End of `docs/security/booking_path_encryption.md`. Introduced Session S-14b + S-14c (2026-09-06). Cross-references: `docs/security/saved_travelers_encryption.md` (Session 36, S-14 predecessor), `TumaFly_SOP_Master.md` §1.5 (rotation), `TumaFly_RUNBOOK_Master.md` §7 (verification cadence — added this session), Framework Doc §5.2 (v1.1 draft accompanying this session).*