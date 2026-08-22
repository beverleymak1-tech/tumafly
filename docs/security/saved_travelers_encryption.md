# TumaFly `saved_travelers` Column Encryption

**Domain:** Postgres column-level encryption for sensitive fields on `public.saved_travelers`
**Owner:** Backend engineer with security ownership (currently: Founder)
**KYC alignment:** closes gap 2.14 (column-level encryption on `saved_travelers` sensitive fields)
**Introduced:** Session 36 (2026-08-19)
**S-14 close:** this document

---

## 1. Purpose + scope

Source-of-truth attestation for the column-level encryption posture on `saved_travelers`. Referenced by KYC §2.14 and the Security Framework doc's data-at-rest protection section.

**Note on the tool pivot.** The Session 35b→36 handoff and the original KYC submission both named `pgsodium` as the encryption primitive (KYC §2.14 language: *"column-level encryption via pgsodium"*). Session 36 opened by discovering Supabase has deprecated pgsodium for Transparent Column Encryption, per their own docs: *"we do not recommend using either [Server Key Management or TCE] on the Supabase platform due to their high level of operational complexity and misconfiguration risk"* and *"the pgsodium extension is expected to go through a deprecation cycle in the near future."* Session 36 pivoted to `pgcrypto` — a standard Postgres core-contrib extension with no deprecation risk, same threat-model coverage, and identical architectural pattern (view + trigger + Vault-stored key + SECURITY DEFINER wrapper). Session 37 KYC Part C v1.2 re-attestation batch will update KYC §2.14 language from "pgsodium" to "pgcrypto" with rationale.

**Threat model addressed.** Passport data + associated travel identity fields are sensitive personal information under Kenya DPA §44 (health-adjacent for `special_assistance`) and under industry-standard PII classifications for the remaining columns. Without column encryption:
- DB dumps / exports / WAL files leaked externally would contain plaintext even though Supabase encrypts at rest (encryption at rest protects against physical disk theft; it does not protect data in dumps or backups sent through unencrypted channels)
- Any Supabase dashboard user (founder, invited team members, temporary contractors with dashboard access) can query plaintext values via SQL Editor with `SELECT * FROM saved_travelers`
- SQL query logs may contain plaintext values from `WHERE` clauses or `INSERT` payloads

With column encryption + Vault-stored key + SECURITY DEFINER wrapper:
- Dumps contain PGP ciphertext for the 10 sensitive columns
- Dashboard users querying `saved_travelers` directly see ciphertext; decryption requires explicit call through the wrapper function which we can audit
- Query logs no longer contain sensitive plaintext for these columns (only ciphertext in `INSERT` payloads pre-trigger and in wrapper function call sites)

**In scope (10 columns encrypted):**
- `passport_number`, `passport_expires`, `passport_country`
- `born_on`, `nationality`, `gender`
- `frequent_flyer` (JSONB, stored as encrypted JSON string)
- `special_assistance`, `known_traveler_id`, `redress_number`

**Out of scope (columns NOT encrypted, with rationale):**
- `id`, `user_id` — needed as FK targets and RLS filter references
- `given_name`, `middle_name`, `family_name`, `title` — queryability + display performance (frontend renders "Ms. Smith" without decrypt overhead); names are commonly-held identifiers, not the sensitive tier
- `created_at`, `updated_at` — timestamps only, no identity signal

**Not addressed by this control (deferred to Ops-1):**
- `pending_bookings.passengers` JSONB — ephemeral (30-day retention via S-09 RTBF), lower priority
- `bookings.passenger_details` JSONB — encrypting would break Duffel reconciliation on retry paths + confirmation email rendering
- Application-layer encryption in EFs — would require rewriting frontend PostgREST calls through EFs; deferred as beyond Session 36 scope

---

## 2. Configuration inventory

### 2.1 Encryption primitive

**Extension:** `pgcrypto` v1.3 (Postgres core-contrib, installed in `extensions` schema — Supabase default enablement)
**Function used:** `extensions.pgp_sym_encrypt(text, passphrase) → bytea` for writes, `extensions.pgp_sym_decrypt(bytea, passphrase) → text` for reads
**Cipher:** AES-256-CBC in PGP packet format (pgcrypto default for `pgp_sym_*`)
**Storage format:** encrypted bytes are base64-encoded and stored as `text` columns. Rationale: PostgREST handles text writes natively (frontend sends plaintext string, arrives as string, trigger encrypts + base64-encodes for storage). If columns were declared `bytea`, PostgREST would fail to coerce inbound JSON strings without frontend-side base64 wrapping — that would push complexity to the frontend for zero storage benefit. Base64 overhead is ~33%; storage cost is negligible at expected row counts.

### 2.2 Key management

**Passphrase storage:** Supabase Vault (`vault.secrets` table, encrypted-at-rest via Vault's own per-project root key)
**Vault secret name:** `saved_travelers_encryption_v1`
**Vault secret ID:** `03b9ffa5-abdf-41e9-8796-5f1ec58ff6a7`
**Passphrase generation:** `encode(gen_random_bytes(32), 'base64')` — 32 bytes (256 bits) of cryptographically random entropy, base64-encoded to a ~44-character text passphrase
**Passphrase access:** only via `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'saved_travelers_encryption_v1'` — restricted to roles with Vault SELECT (postgres, service_role by default). Not accessible to `authenticated` or `anon` directly.
**Versioned naming:** `_v1` suffix supports future rotations to `_v2`, `_v3`, etc., with the SECURITY DEFINER wrapper updated to read the current-version key name at rotation time.

### 2.3 SECURITY DEFINER wrapper functions

Two wrappers in the `public` schema mediate all encrypt/decrypt operations:

**`public.encrypt_saved_traveler_field(plaintext text) RETURNS bytea`**
- SECURITY DEFINER — runs with postgres privileges to read from Vault
- STRICT — returns NULL if input is NULL (skips execution entirely at parser level)
- STABLE — allows Postgres to optimize repeated calls within a single query
- `SET search_path = extensions, public` — prevents search-path injection attacks
- Reads passphrase from Vault, calls `pgp_sym_encrypt(plaintext, passphrase)`

**`public.decrypt_saved_traveler_field(ciphertext bytea) RETURNS text`**
- Same modifiers as encrypt wrapper
- Reads passphrase from Vault, calls `pgp_sym_decrypt(ciphertext, passphrase)`

**Grants:**
- `authenticated`, `service_role`: EXECUTE granted on both wrappers
- `anon`: EXECUTE explicitly REVOKED (defense-in-depth against Supabase's default `GRANT EXECUTE TO PUBLIC`)
- `postgres`: EXECUTE by ownership

### 2.4 Trigger-based encrypt-on-write

**Trigger:** `saved_travelers_encrypt` (BEFORE INSERT OR UPDATE, FOR EACH ROW)
**Function:** `public.encrypt_saved_traveler_columns()` (SECURITY DEFINER)

Behavior:
- **On INSERT:** encrypts every non-NULL sensitive column via `encode(encrypt_saved_traveler_field(NEW.column), 'base64')`
- **On UPDATE:** encrypts only columns where `NEW.column IS DISTINCT FROM OLD.column`. This prevents double-encryption when a caller passes through an already-encrypted value in a partial update (e.g., "change middle_name but leave passport_number as-is" would otherwise pass the encrypted passport_number back through the trigger and encrypt it a second time, corrupting it).
- **NULL passthrough:** STRICT modifier on the wrapper means NULL inputs return NULL, preserving nullability of optional columns.

### 2.5 View-based decrypt-on-read

**View:** `public.saved_travelers_decrypted` with `security_invoker = true`

Structure:
- Unencrypted columns (`id`, `user_id`, `given_name`, etc.) selected directly
- Encrypted columns decoded from base64, decrypted via wrapper, cast back to display type (text for most, JSONB for `frequent_flyer`)
- `security_invoker = true` — RLS policies on the underlying `saved_travelers` table apply based on the calling role's `auth.uid()`, NOT the view creator's (postgres). This means an authenticated user only sees rows they own via the RLS `auth.uid() = user_id` filter.

**Grants:**
- `authenticated`, `service_role`: SELECT granted
- `anon`: explicit REVOKE (defense-in-depth; RLS would filter to zero rows anyway since anon has no `auth.uid()`)

### 2.6 RLS policies on underlying `saved_travelers`

Confirmed present (from Session 35 S-12 cleanup, unchanged Session 36):
- `Users can view own travelers` (SELECT): `auth.uid() = user_id`
- `Users can insert own travelers` (INSERT): WITH CHECK `auth.uid() = user_id`
- `Users can update own travelers` (UPDATE): `auth.uid() = user_id` for both USING and WITH CHECK
- `Users can delete own travelers` (DELETE): `auth.uid() = user_id`
- `Service role full access` (ALL): `auth.role() = 'service_role'`

`rowsecurity = true` on `saved_travelers`.

---

## 3. Verification

### 3.1 Session 36 deployment verification (2026-08-19)

**Backend round-trip (SQL Editor as postgres):**
- INSERT synthetic row with 10 plaintext sensitive fields
- Read raw row: all 10 columns show base64 PGP ciphertext starting with `ww0EBwMC...` (base64 of PGP symmetric-encryption packet header `\xC3\x0D`), confirmed NOT plaintext
- Read via view: all 10 columns decrypt to exact original values, including JSONB round-trip for `frequent_flyer`
- DELETE cleanup succeeded, 0 residual rows

**Grant/policy topology verified:**
- Wrapper functions: `authenticated` and `service_role` have EXECUTE; `anon` explicitly REVOKED
- View: `authenticated` and `service_role` have SELECT; `anon` implicitly REVOKED (never granted)
- Raw table: standard Supabase grants; RLS enforces per-user isolation
- RLS enabled on `saved_travelers`: `rowsecurity = true`

**Frontend end-to-end (production, `bev@congressdurham.com`):**
- Login → booking flow → passenger form → picker renders empty state (0 saved travelers) ✅
- Save a traveler via form UI → frontend POSTs to `saved_travelers` → trigger encrypts → row lands as ciphertext ✅
- Refresh → picker renders saved traveler with plaintext name via `saved_travelers_decrypted` view ✅
- Delete via picker UI → row removed ✅
- Post-cleanup SQL spot check: `SELECT COUNT(*) FROM saved_travelers` returns 0 ✅

### 3.2 Ongoing regression grep after any EF or frontend edit touching `saved_travelers`

Backend (should return zero — no EF currently touches `saved_travelers`):
```bash
grep -rn "saved_travelers" supabase/functions/
```

Frontend (should show exactly the current topology — 1 read via view, 3 writes/deletes via raw table):
```bash
grep -n "from(.saved_travelers" frontend/index.html
```

Expected shape:
- 1× `.from('saved_travelers_decrypted')` — the read at `fetchSavedTravelers` (~line 16947)
- 2× `.from('saved_travelers').upsert(...)` — the writes (~lines 17116, 23205)
- 1× `.from('saved_travelers').delete()` — the delete (~line 23220)

Any drift from this shape (read pointing at raw table, or write pointing at view) is a regression.

### 3.3 Synthetic round-trip test for future validation

```sql
-- Run as postgres in SQL Editor. Requires a valid profiles.id for user_id.
WITH inserted AS (
  INSERT INTO saved_travelers (
    user_id, given_name, family_name,
    passport_number, born_on, nationality
  )
  VALUES (
    (SELECT id FROM profiles LIMIT 1),
    'SmokeTest', 'RoundTrip',
    'A1234567', '1990-01-15', 'KE'
  )
  RETURNING id
),
raw_row AS (
  SELECT id, substring(passport_number, 1, 20) AS preview
  FROM saved_travelers WHERE id IN (SELECT id FROM inserted)
),
decrypted_row AS (
  SELECT id, passport_number
  FROM saved_travelers_decrypted WHERE id IN (SELECT id FROM inserted)
),
cleanup AS (
  DELETE FROM saved_travelers WHERE id IN (SELECT id FROM inserted)
  RETURNING 1
)
SELECT
  jsonb_build_object(
    'raw_ciphertext_starts_with_ww0', (SELECT preview FROM raw_row) LIKE 'ww0%',
    'view_returns_plaintext', (SELECT passport_number FROM decrypted_row) = 'A1234567',
    'cleanup_rows', (SELECT COUNT(*) FROM cleanup)
  ) AS test_result;
```

Expected: `raw_ciphertext_starts_with_ww0: true`, `view_returns_plaintext: true`, `cleanup_rows: 1`.

---

## 4. Rollback

### 4.1 Backup source

`saved_travelers_pre_s14_backup` table exists in the `public` schema (created Session 36 Phase 2). Contains 6 pre-migration rows (all test data — 3 rows on `bev@congressdurham.com`, 1 on `beverley.mak1@gmail.com`, 2 on Wigatech vendor accounts). Retention: 7 days post-migration, drop planned for Session 37 (on or after 2026-08-26).

**Grants on backup:** REVOKE ALL from `anon`, `authenticated`. Only `postgres` and `service_role` can read.

### 4.2 Rollback procedure (if needed)

Full rollback to pre-encryption plaintext state:

```sql
BEGIN;
  -- Drop the encrypted table + view + trigger (CASCADE removes dependents)
  DROP TABLE saved_travelers CASCADE;

  -- Restore from snapshot (this restores the plaintext table structure + rows)
  CREATE TABLE saved_travelers AS SELECT * FROM saved_travelers_pre_s14_backup;

  -- Re-apply RLS policies (captured from pg_policies pre-migration; see §4.3)
  -- Re-apply RLS enable
  ALTER TABLE saved_travelers ENABLE ROW LEVEL SECURITY;
  -- ... re-apply the 5 policies from §2.6

  -- Re-apply the FK to profiles
  ALTER TABLE saved_travelers ADD CONSTRAINT saved_travelers_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

  -- Re-apply grants
  GRANT SELECT, INSERT, UPDATE, DELETE ON saved_travelers TO authenticated;
  GRANT ALL ON saved_travelers TO service_role;

COMMIT;
```

After DB rollback, revert the frontend commit `68551aa`:
```bash
cd ~/tumafly-backend
git revert 68551aa
git push origin main
```

Cloudflare Pages redeploys with frontend reading from raw table again.

### 4.3 Partial rollback (surgical)

If only one column's encryption needs to be undone (e.g., `frequent_flyer` JSONB round-trip has a bug that surfaces later), the approach is:
1. Add a plaintext column: `ALTER TABLE saved_travelers ADD COLUMN frequent_flyer_plain jsonb;`
2. Backfill: `UPDATE saved_travelers SET frequent_flyer_plain = (SELECT frequent_flyer FROM saved_travelers_decrypted WHERE id = saved_travelers.id);`
3. Drop encrypted column, rename plaintext column: `ALTER TABLE saved_travelers DROP COLUMN frequent_flyer; ALTER TABLE saved_travelers RENAME COLUMN frequent_flyer_plain TO frequent_flyer;`
4. Update the view + trigger to no longer include `frequent_flyer` in their encrypted-column loops.

This preserves the encryption for other columns while undoing one.

---

## 5. Backlog / known limitations

### 5.1 `frequent_flyer` blob-encryption tradeoff

`frequent_flyer` is JSONB in the frontend's mental model but encrypted as a single blob (encrypted JSON string). Consequence: cannot query by nested path (e.g., `frequent_flyer @> '{"airline_iata_code": "KQ"}'`). Verified pre-migration via `grep -n "frequent_flyer" ~/tumafly-backend/frontend/index.html` — every access is whole-array read or JS-side iteration, no PostgREST path filters. If a future frontend feature needs to query FF by airline (e.g., "show all travelers with Kenya Airways loyalty accounts"), the FF column would need to be either (a) unencrypted, or (b) supplemented with an unencrypted `frequent_flyer_airlines text[]` index column extracted at write time.

### 5.2 Rotation is expensive at scale

Key rotation requires re-encrypting every row (decrypt with old key → encrypt with new key) in a single transaction. At current row count (~single digits), this is instant. At ~10k rows, ~few seconds. At ~1M rows, ~minutes. The scheduled annual rotation cadence assumes we're in the low-thousands-of-rows range for the foreseeable future; if `saved_travelers` grows to millions, revisit rotation architecture (chunked rotation with dual-read window, or accept longer maintenance window).

### 5.3 Vault access = decryption access

Anyone with dashboard access can query `vault.decrypted_secrets` and retrieve the passphrase, then decrypt any ciphertext. This is the fundamental limitation of database-side encryption (Supabase's own guidance flags this). Mitigations:
- Reduce dashboard access surface: SOP §7 MFA policy (Session 35d) reduces credential-compromise risk
- Vendor account offboarding hygiene (session-close backlog): ensure vendors granted dashboard access during evaluation have credentials revoked at engagement end
- Alerting on Vault reads (deferred; not currently instrumented — Ops-1 addition candidate)

### 5.4 Backup file drops in Session 37

`saved_travelers_pre_s14_backup` retained 7 days post-migration per Session 35b handoff Decision 5. Drop scheduled: on or after 2026-08-26 (Session 37 opening task).

### 5.5 Post-migration verification is manual

No automated post-deploy check exists for "the encryption topology is intact" (view still points at wrapper, trigger still fires, RLS still enabled). Session 35b's `scripts/post_deploy_smoke.sh` covers the booking pipeline but not saved_travelers encryption. If a future migration accidentally drops the trigger, encryption silently stops working for new inserts. Backlog: add a `scripts/verify_saved_travelers_encryption.sh` (or extend `post_deploy_smoke.sh`) that runs the §3.3 synthetic round-trip on every deploy.

---

## 6. Change management

See SOP Master §6 — Configuration Change Management.

Changes to any of:
- The 10 encrypted columns (adding, removing, renaming)
- The wrapper functions (`public.encrypt_saved_traveler_field`, `public.decrypt_saved_traveler_field`)
- The trigger function (`public.encrypt_saved_traveler_columns`)
- The view (`public.saved_travelers_decrypted`)
- Vault secret `saved_travelers_encryption_v1` (rotation, replacement)

...MUST follow the change management protocol: pre-change snapshot, transactional migration, post-change verification via §3.3 synthetic round-trip, and this document's §7 deployment record updated with the migration date + change summary.

Key rotation follows SOP §1.5 (Session 36 DocUpdate — new procedure added for pgcrypto/Vault passphrase rotation).

---

## 7. Deployment record

**Session 36 (2026-08-19):** initial S-14 pgcrypto column encryption. 10 sensitive columns on `saved_travelers` encrypted via `pgp_sym_encrypt/decrypt` with Vault-stored 256-bit passphrase, SECURITY DEFINER wrapper functions, BEFORE INSERT/UPDATE trigger, `security_invoker` view. Frontend switched to read via view (single-line change at `frontend/index.html` line 16947). Pre-migration purge cleared 6 test rows; post-migration verification via synthetic SQL round-trip + real frontend end-to-end flow on `bev@congressdurham.com` account. Zero real-customer data existed at time of encryption ship — strongest possible posture.

**Configured by:** Founder (Bev) via chat handoff
**Session:** 36
**Repo commits landed:** `68551aa` (frontend switch to `saved_travelers_decrypted` view)
**Non-repo state changes:** pgcrypto column migration + wrapper functions + trigger + view (all DB-only, not in migrations dir — recorded here as authoritative source)

---

*End of `saved_travelers` column encryption attestation. First landed Session 36 (2026-08-19). Pivoted from pgsodium to pgcrypto per Supabase's pgsodium TCE deprecation guidance.*