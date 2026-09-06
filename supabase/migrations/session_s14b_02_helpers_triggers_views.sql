-- ═══════════════════════════════════════════════════════════════════════════
-- Session S-14b — Phase 2 (JSONB helpers) + Phase 4 (triggers) + Phase 5 (views)
-- Corrected against actual pending_bookings + bookings schema.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- Phase 2 — JSONB walker helpers
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.encrypt_passenger_pii(passengers_in jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = extensions, public
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  passenger jsonb;
  doc jsonb;
  new_docs jsonb;
  top_fields text[] := ARRAY[
    'title','gender','given_name','family_name','middle_name',
    'born_on','nationality',
    'known_traveler_id','redress_number','special_assistance'
  ];
  doc_fields text[] := ARRAY['unique_identifier','expires_on','issuing_country_code'];
  fld text;
BEGIN
  IF passengers_in IS NULL OR jsonb_array_length(passengers_in) = 0 THEN
    RETURN passengers_in;
  END IF;
  IF (passengers_in->0) ? '_pii_encrypted' THEN
    RETURN passengers_in;
  END IF;

  FOR passenger IN SELECT jsonb_array_elements(passengers_in) LOOP
    FOREACH fld IN ARRAY top_fields LOOP
      IF passenger ? fld
         AND jsonb_typeof(passenger->fld) = 'string'
         AND passenger->>fld <> '' THEN
        passenger := jsonb_set(
          passenger, ARRAY[fld],
          to_jsonb(encode(public.encrypt_saved_traveler_field(passenger->>fld), 'base64'))
        );
      END IF;
    END LOOP;

    IF passenger ? 'loyalty_programme_accounts'
       AND jsonb_typeof(passenger->'loyalty_programme_accounts') = 'array'
       AND jsonb_array_length(passenger->'loyalty_programme_accounts') > 0 THEN
      passenger := jsonb_set(
        passenger, '{loyalty_programme_accounts}',
        to_jsonb(encode(
          public.encrypt_saved_traveler_field((passenger->'loyalty_programme_accounts')::text),
          'base64'
        ))
      );
    END IF;

    IF passenger ? 'identity_documents'
       AND jsonb_typeof(passenger->'identity_documents') = 'array' THEN
      new_docs := '[]'::jsonb;
      FOR doc IN SELECT jsonb_array_elements(passenger->'identity_documents') LOOP
        FOREACH fld IN ARRAY doc_fields LOOP
          IF doc ? fld
             AND jsonb_typeof(doc->fld) = 'string'
             AND doc->>fld <> '' THEN
            doc := jsonb_set(
              doc, ARRAY[fld],
              to_jsonb(encode(public.encrypt_saved_traveler_field(doc->>fld), 'base64'))
            );
          END IF;
        END LOOP;
        new_docs := new_docs || jsonb_build_array(doc);
      END LOOP;
      passenger := jsonb_set(passenger, '{identity_documents}', new_docs);
    END IF;

    passenger := passenger || '{"_pii_encrypted": true, "_pii_version": 1}'::jsonb;
    result := result || jsonb_build_array(passenger);
  END LOOP;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_passenger_pii(passengers_in jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = extensions, public
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  passenger jsonb;
  doc jsonb;
  new_docs jsonb;
  top_fields text[] := ARRAY[
    'title','gender','given_name','family_name','middle_name',
    'born_on','nationality',
    'known_traveler_id','redress_number','special_assistance'
  ];
  doc_fields text[] := ARRAY['unique_identifier','expires_on','issuing_country_code'];
  fld text;
  loyalty_json text;
BEGIN
  IF passengers_in IS NULL OR jsonb_array_length(passengers_in) = 0 THEN
    RETURN passengers_in;
  END IF;
  IF NOT ((passengers_in->0) ? '_pii_encrypted') THEN
    RETURN passengers_in;
  END IF;

  FOR passenger IN SELECT jsonb_array_elements(passengers_in) LOOP
    FOREACH fld IN ARRAY top_fields LOOP
      IF passenger ? fld
         AND jsonb_typeof(passenger->fld) = 'string'
         AND passenger->>fld <> '' THEN
        passenger := jsonb_set(
          passenger, ARRAY[fld],
          to_jsonb(public.decrypt_saved_traveler_field(decode(passenger->>fld, 'base64')))
        );
      END IF;
    END LOOP;

    IF passenger ? 'loyalty_programme_accounts'
       AND jsonb_typeof(passenger->'loyalty_programme_accounts') = 'string' THEN
      loyalty_json := public.decrypt_saved_traveler_field(
        decode(passenger->>'loyalty_programme_accounts', 'base64')
      );
      passenger := jsonb_set(passenger, '{loyalty_programme_accounts}', loyalty_json::jsonb);
    END IF;

    IF passenger ? 'identity_documents'
       AND jsonb_typeof(passenger->'identity_documents') = 'array' THEN
      new_docs := '[]'::jsonb;
      FOR doc IN SELECT jsonb_array_elements(passenger->'identity_documents') LOOP
        FOREACH fld IN ARRAY doc_fields LOOP
          IF doc ? fld
             AND jsonb_typeof(doc->fld) = 'string'
             AND doc->>fld <> '' THEN
            doc := jsonb_set(
              doc, ARRAY[fld],
              to_jsonb(public.decrypt_saved_traveler_field(decode(doc->>fld, 'base64')))
            );
          END IF;
        END LOOP;
        new_docs := new_docs || jsonb_build_array(doc);
      END LOOP;
      passenger := jsonb_set(passenger, '{identity_documents}', new_docs);
    END IF;

    passenger := passenger - '_pii_encrypted' - '_pii_version';
    result := result || jsonb_build_array(passenger);
  END LOOP;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.encrypt_booking_display_pii(details_in jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = extensions, public
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  passenger jsonb;
  segment jsonb;
  new_segments jsonb;
BEGIN
  IF details_in IS NULL OR jsonb_array_length(details_in) = 0 THEN
    RETURN details_in;
  END IF;
  IF (details_in->0) ? '_pii_encrypted' THEN
    RETURN details_in;
  END IF;

  FOR passenger IN SELECT jsonb_array_elements(details_in) LOOP
    IF passenger ? 'name'
       AND jsonb_typeof(passenger->'name') = 'string'
       AND passenger->>'name' <> '' THEN
      passenger := jsonb_set(
        passenger, '{name}',
        to_jsonb(encode(public.encrypt_saved_traveler_field(passenger->>'name'), 'base64'))
      );
    END IF;
    IF passenger ? 'segments'
       AND jsonb_typeof(passenger->'segments') = 'array' THEN
      new_segments := '[]'::jsonb;
      FOR segment IN SELECT jsonb_array_elements(passenger->'segments') LOOP
        IF segment ? 'ticket'
           AND jsonb_typeof(segment->'ticket') = 'string'
           AND segment->>'ticket' <> '' THEN
          segment := jsonb_set(
            segment, '{ticket}',
            to_jsonb(encode(public.encrypt_saved_traveler_field(segment->>'ticket'), 'base64'))
          );
        END IF;
        new_segments := new_segments || jsonb_build_array(segment);
      END LOOP;
      passenger := jsonb_set(passenger, '{segments}', new_segments);
    END IF;
    passenger := passenger || '{"_pii_encrypted": true, "_pii_version": 1}'::jsonb;
    result := result || jsonb_build_array(passenger);
  END LOOP;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_booking_display_pii(details_in jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = extensions, public
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  passenger jsonb;
  segment jsonb;
  new_segments jsonb;
BEGIN
  IF details_in IS NULL OR jsonb_array_length(details_in) = 0 THEN
    RETURN details_in;
  END IF;
  IF NOT ((details_in->0) ? '_pii_encrypted') THEN
    RETURN details_in;
  END IF;

  FOR passenger IN SELECT jsonb_array_elements(details_in) LOOP
    IF passenger ? 'name'
       AND jsonb_typeof(passenger->'name') = 'string'
       AND passenger->>'name' <> '' THEN
      passenger := jsonb_set(
        passenger, '{name}',
        to_jsonb(public.decrypt_saved_traveler_field(decode(passenger->>'name', 'base64')))
      );
    END IF;
    IF passenger ? 'segments'
       AND jsonb_typeof(passenger->'segments') = 'array' THEN
      new_segments := '[]'::jsonb;
      FOR segment IN SELECT jsonb_array_elements(passenger->'segments') LOOP
        IF segment ? 'ticket'
           AND jsonb_typeof(segment->'ticket') = 'string'
           AND segment->>'ticket' <> '' THEN
          segment := jsonb_set(
            segment, '{ticket}',
            to_jsonb(public.decrypt_saved_traveler_field(decode(segment->>'ticket', 'base64')))
          );
        END IF;
        new_segments := new_segments || jsonb_build_array(segment);
      END LOOP;
      passenger := jsonb_set(passenger, '{segments}', new_segments);
    END IF;
    passenger := passenger - '_pii_encrypted' - '_pii_version';
    result := result || jsonb_build_array(passenger);
  END LOOP;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.encrypt_passenger_pii(jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.decrypt_passenger_pii(jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.encrypt_booking_display_pii(jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.decrypt_booking_display_pii(jsonb) FROM public, anon;

GRANT EXECUTE ON FUNCTION public.encrypt_passenger_pii(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_passenger_pii(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_booking_display_pii(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_booking_display_pii(jsonb) TO authenticated, service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- Phase 4 — triggers
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.encrypt_pending_bookings_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public
AS $$
BEGIN
  IF NEW.passengers IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.passengers IS DISTINCT FROM OLD.passengers) THEN
    NEW.passengers := public.encrypt_passenger_pii(NEW.passengers);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pending_bookings_encrypt_passengers ON public.pending_bookings;
CREATE TRIGGER pending_bookings_encrypt_passengers
  BEFORE INSERT OR UPDATE OF passengers ON public.pending_bookings
  FOR EACH ROW EXECUTE FUNCTION public.encrypt_pending_bookings_trigger();

CREATE OR REPLACE FUNCTION public.encrypt_bookings_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public
AS $$
BEGIN
  IF NEW.passenger_name IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.passenger_name IS DISTINCT FROM OLD.passenger_name)
     AND NEW.passenger_name NOT LIKE 'ww0EBwMC%' THEN
    NEW.passenger_name := encode(
      public.encrypt_saved_traveler_field(NEW.passenger_name), 'base64'
    );
  END IF;

  IF NEW.passenger_email IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.passenger_email IS DISTINCT FROM OLD.passenger_email)
     AND NEW.passenger_email NOT LIKE 'ww0EBwMC%' THEN
    NEW.passenger_email := encode(
      public.encrypt_saved_traveler_field(NEW.passenger_email), 'base64'
    );
  END IF;

  IF NEW.passenger_phone IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.passenger_phone IS DISTINCT FROM OLD.passenger_phone)
     AND NEW.passenger_phone NOT LIKE 'ww0EBwMC%' THEN
    NEW.passenger_phone := encode(
      public.encrypt_saved_traveler_field(NEW.passenger_phone), 'base64'
    );
  END IF;

  IF NEW.passenger_details IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.passenger_details IS DISTINCT FROM OLD.passenger_details) THEN
    NEW.passenger_details := public.encrypt_booking_display_pii(NEW.passenger_details);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_encrypt_pii ON public.bookings;
CREATE TRIGGER bookings_encrypt_pii
  BEFORE INSERT OR UPDATE OF passenger_name, passenger_email, passenger_phone, passenger_details
  ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.encrypt_bookings_trigger();


-- ───────────────────────────────────────────────────────────────────────────
-- Phase 5 — decrypted views (corrected against actual schema)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.pending_bookings_decrypted
WITH (security_invoker = true) AS
SELECT
  id,
  merchant_ref,
  processor_transaction_id,
  duffel_offer_id,
  public.decrypt_passenger_pii(passengers) AS passengers,
  contact,
  base_amount_kes,
  service_fee_kes,
  processing_fee_kes,
  total_kes,
  payment_method,
  status,
  duffel_order_id,
  booking_reference,
  created_at,
  expires_at,
  mpesa_checkout_request_id,
  mpesa_merchant_request_id,
  mpesa_receipt_number,
  mpesa_transaction_date,
  daraja_result_code,
  daraja_result_desc,
  updated_at,
  user_id,
  confirmation_email_sent_at,
  guest_token,
  guest_token_attempts
FROM public.pending_bookings;

CREATE OR REPLACE VIEW public.bookings_decrypted
WITH (security_invoker = true) AS
SELECT
  id,
  created_at,
  duffel_order_id,
  booking_reference,
  origin,
  destination,
  departure_at,
  airline,
  flight_number,
  total_amount,
  total_currency,
  CASE WHEN passenger_name IS NULL THEN NULL
       ELSE public.decrypt_saved_traveler_field(decode(passenger_name, 'base64'))
  END AS passenger_name,
  CASE WHEN passenger_email IS NULL THEN NULL
       ELSE public.decrypt_saved_traveler_field(decode(passenger_email, 'base64'))
  END AS passenger_email,
  CASE WHEN passenger_phone IS NULL THEN NULL
       ELSE public.decrypt_saved_traveler_field(decode(passenger_phone, 'base64'))
  END AS passenger_phone,
  status,
  trip_type,
  return_date,
  return_airline,
  return_flight_number,
  inbound_duffel_order_id,
  inbound_booking_reference,
  passenger_count,
  total_paid_kes,
  service_fee_kes,
  processing_fee_kes,
  payment_method,
  processor_transaction_id,
  processor_authorization_code,
  etims_receipt_number,
  etims_qr_code_url,
  etims_status,
  etims_issued_at,
  mpesa_receipt_number,
  user_id,
  cabin_class,
  fare_brand_name,
  public.decrypt_booking_display_pii(passenger_details) AS passenger_details,
  baggage_included,
  seat_selection_paid,
  changes_allowed,
  seats_selected,
  payment_account_last4,
  pending_booking_id,
  updated_at
FROM public.bookings;

GRANT SELECT ON public.pending_bookings_decrypted TO authenticated, service_role;
GRANT SELECT ON public.bookings_decrypted TO authenticated, service_role;