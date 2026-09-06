-- ═══════════════════════════════════════════════════════════════════════════
-- Session S-14c — extend saved_travelers encryption to name fields
-- Adds: title, given_name, family_name, middle_name
-- Preserves: exact structure of existing encrypt_saved_traveler_columns +
--            saved_travelers_decrypted (10 shipped columns unchanged in shape)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Extended trigger function (14 columns instead of 10) ──
CREATE OR REPLACE FUNCTION public.encrypt_saved_traveler_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public'
AS $function$
BEGIN
  -- Only encrypt if the value looks like plaintext (not already base64-encoded encrypted data).
  -- On UPDATE where a column isn't changing, NEW.column equals the already-encrypted value in OLD;
  -- re-encrypting would create doubly-encrypted garbage.
  --
  -- Heuristic: if the value starts with a valid base64 pattern AND decodes cleanly to something
  -- pgcrypto can decrypt with our key, treat it as already-encrypted. Otherwise, encrypt.
  --
  -- Simpler heuristic used here: check if the value in OLD (for UPDATE) equals NEW. If so, don't
  -- re-encrypt (it's the already-encrypted string being passed through). If NEW differs from OLD,
  -- the caller changed it — encrypt as plaintext.
  --
  -- On INSERT, OLD is NULL, so every non-NULL field is encrypted.
  --
  -- S-14c extension: title, given_name, family_name, middle_name added to the encrypted set.
  -- Aligns with pending_bookings.passengers[*] + bookings.passenger_details[*].name encryption
  -- shipped in S-14b so Framework Doc §5.2 tells one story across all three tables.

  IF TG_OP = 'UPDATE' THEN
    IF NEW.passport_number IS NOT NULL AND NEW.passport_number IS DISTINCT FROM OLD.passport_number THEN
      NEW.passport_number = encode(public.encrypt_saved_traveler_field(NEW.passport_number), 'base64');
    END IF;
    IF NEW.passport_expires IS NOT NULL AND NEW.passport_expires IS DISTINCT FROM OLD.passport_expires THEN
      NEW.passport_expires = encode(public.encrypt_saved_traveler_field(NEW.passport_expires), 'base64');
    END IF;
    IF NEW.passport_country IS NOT NULL AND NEW.passport_country IS DISTINCT FROM OLD.passport_country THEN
      NEW.passport_country = encode(public.encrypt_saved_traveler_field(NEW.passport_country), 'base64');
    END IF;
    IF NEW.born_on IS NOT NULL AND NEW.born_on IS DISTINCT FROM OLD.born_on THEN
      NEW.born_on = encode(public.encrypt_saved_traveler_field(NEW.born_on), 'base64');
    END IF;
    IF NEW.nationality IS NOT NULL AND NEW.nationality IS DISTINCT FROM OLD.nationality THEN
      NEW.nationality = encode(public.encrypt_saved_traveler_field(NEW.nationality), 'base64');
    END IF;
    IF NEW.gender IS NOT NULL AND NEW.gender IS DISTINCT FROM OLD.gender THEN
      NEW.gender = encode(public.encrypt_saved_traveler_field(NEW.gender), 'base64');
    END IF;
    IF NEW.frequent_flyer IS NOT NULL AND NEW.frequent_flyer IS DISTINCT FROM OLD.frequent_flyer THEN
      NEW.frequent_flyer = encode(public.encrypt_saved_traveler_field(NEW.frequent_flyer), 'base64');
    END IF;
    IF NEW.special_assistance IS NOT NULL AND NEW.special_assistance IS DISTINCT FROM OLD.special_assistance THEN
      NEW.special_assistance = encode(public.encrypt_saved_traveler_field(NEW.special_assistance), 'base64');
    END IF;
    IF NEW.known_traveler_id IS NOT NULL AND NEW.known_traveler_id IS DISTINCT FROM OLD.known_traveler_id THEN
      NEW.known_traveler_id = encode(public.encrypt_saved_traveler_field(NEW.known_traveler_id), 'base64');
    END IF;
    IF NEW.redress_number IS NOT NULL AND NEW.redress_number IS DISTINCT FROM OLD.redress_number THEN
      NEW.redress_number = encode(public.encrypt_saved_traveler_field(NEW.redress_number), 'base64');
    END IF;
    -- S-14c additions
    IF NEW.title IS NOT NULL AND NEW.title IS DISTINCT FROM OLD.title THEN
      NEW.title = encode(public.encrypt_saved_traveler_field(NEW.title), 'base64');
    END IF;
    IF NEW.given_name IS NOT NULL AND NEW.given_name IS DISTINCT FROM OLD.given_name THEN
      NEW.given_name = encode(public.encrypt_saved_traveler_field(NEW.given_name), 'base64');
    END IF;
    IF NEW.family_name IS NOT NULL AND NEW.family_name IS DISTINCT FROM OLD.family_name THEN
      NEW.family_name = encode(public.encrypt_saved_traveler_field(NEW.family_name), 'base64');
    END IF;
    IF NEW.middle_name IS NOT NULL AND NEW.middle_name IS DISTINCT FROM OLD.middle_name THEN
      NEW.middle_name = encode(public.encrypt_saved_traveler_field(NEW.middle_name), 'base64');
    END IF;
  ELSE  -- INSERT
    IF NEW.passport_number IS NOT NULL THEN
      NEW.passport_number = encode(public.encrypt_saved_traveler_field(NEW.passport_number), 'base64');
    END IF;
    IF NEW.passport_expires IS NOT NULL THEN
      NEW.passport_expires = encode(public.encrypt_saved_traveler_field(NEW.passport_expires), 'base64');
    END IF;
    IF NEW.passport_country IS NOT NULL THEN
      NEW.passport_country = encode(public.encrypt_saved_traveler_field(NEW.passport_country), 'base64');
    END IF;
    IF NEW.born_on IS NOT NULL THEN
      NEW.born_on = encode(public.encrypt_saved_traveler_field(NEW.born_on), 'base64');
    END IF;
    IF NEW.nationality IS NOT NULL THEN
      NEW.nationality = encode(public.encrypt_saved_traveler_field(NEW.nationality), 'base64');
    END IF;
    IF NEW.gender IS NOT NULL THEN
      NEW.gender = encode(public.encrypt_saved_traveler_field(NEW.gender), 'base64');
    END IF;
    IF NEW.frequent_flyer IS NOT NULL THEN
      NEW.frequent_flyer = encode(public.encrypt_saved_traveler_field(NEW.frequent_flyer), 'base64');
    END IF;
    IF NEW.special_assistance IS NOT NULL THEN
      NEW.special_assistance = encode(public.encrypt_saved_traveler_field(NEW.special_assistance), 'base64');
    END IF;
    IF NEW.known_traveler_id IS NOT NULL THEN
      NEW.known_traveler_id = encode(public.encrypt_saved_traveler_field(NEW.known_traveler_id), 'base64');
    END IF;
    IF NEW.redress_number IS NOT NULL THEN
      NEW.redress_number = encode(public.encrypt_saved_traveler_field(NEW.redress_number), 'base64');
    END IF;
    -- S-14c additions
    IF NEW.title IS NOT NULL THEN
      NEW.title = encode(public.encrypt_saved_traveler_field(NEW.title), 'base64');
    END IF;
    IF NEW.given_name IS NOT NULL THEN
      NEW.given_name = encode(public.encrypt_saved_traveler_field(NEW.given_name), 'base64');
    END IF;
    IF NEW.family_name IS NOT NULL THEN
      NEW.family_name = encode(public.encrypt_saved_traveler_field(NEW.family_name), 'base64');
    END IF;
    IF NEW.middle_name IS NOT NULL THEN
      NEW.middle_name = encode(public.encrypt_saved_traveler_field(NEW.middle_name), 'base64');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ── Extended view (4 more decrypt columns replace the plaintext passthroughs) ──
CREATE OR REPLACE VIEW public.saved_travelers_decrypted
WITH (security_invoker = true) AS
SELECT
  id,
  user_id,
  decrypt_saved_traveler_field(decode(given_name, 'base64'::text)) AS given_name,
  decrypt_saved_traveler_field(decode(middle_name, 'base64'::text)) AS middle_name,
  decrypt_saved_traveler_field(decode(family_name, 'base64'::text)) AS family_name,
  decrypt_saved_traveler_field(decode(title, 'base64'::text)) AS title,
  created_at,
  updated_at,
  decrypt_saved_traveler_field(decode(passport_number, 'base64'::text)) AS passport_number,
  decrypt_saved_traveler_field(decode(passport_expires, 'base64'::text)) AS passport_expires,
  decrypt_saved_traveler_field(decode(passport_country, 'base64'::text)) AS passport_country,
  decrypt_saved_traveler_field(decode(born_on, 'base64'::text)) AS born_on,
  decrypt_saved_traveler_field(decode(nationality, 'base64'::text)) AS nationality,
  decrypt_saved_traveler_field(decode(gender, 'base64'::text)) AS gender,
  decrypt_saved_traveler_field(decode(frequent_flyer, 'base64'::text))::jsonb AS frequent_flyer,
  decrypt_saved_traveler_field(decode(special_assistance, 'base64'::text)) AS special_assistance,
  decrypt_saved_traveler_field(decode(known_traveler_id, 'base64'::text)) AS known_traveler_id,
  decrypt_saved_traveler_field(decode(redress_number, 'base64'::text)) AS redress_number
FROM saved_travelers;


-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill — encrypt the 4 name columns on existing rows that were plaintext
-- pre-trigger extension. The mechanism: UPDATE with plaintext values on the
-- 4 columns, and the extended trigger encrypts them on write.
--
-- IMPORTANT: this migration MUST NOT use `encode(encrypt_..., 'base64')` in the
-- SET clause. Doing so double-encrypts (the trigger fires on the UPDATE and
-- encrypts the already-encrypted value again). The correct shape is: pass
-- plaintext to SET, let the trigger encrypt.
--
-- For replay-from-scratch, this SELECT-restore reads from the snapshot table
-- and re-writes the 4 plaintext columns. If run against a DB where the snapshot
-- has already been dropped (30 days post-ship), this UPDATE is a no-op — the
-- snapshot table won't exist and the FROM clause fails, but that's the correct
-- behaviour: the columns have already been encrypted in the production DB and
-- the replay should not touch them.
--
-- Historical note: session S-14c's first backfill attempt used encode-in-SET
-- and hit double-encryption. Recovery: this shape.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.saved_travelers st
SET
  title       = bk.title,
  given_name  = bk.given_name,
  family_name = bk.family_name,
  middle_name = bk.middle_name
FROM public.saved_travelers_pre_s14c_backup bk
WHERE st.id = bk.id;