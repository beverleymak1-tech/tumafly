// _shared/redact.ts
// PII redaction helper for alert payloads and log statements.
// Ship: S-02 (alert-founder). Reused by: S-04 (log hygiene sweep).
//
// Rules (applied recursively):
//   1. Keys matching PII_KEYS  → value replaced with "[REDACTED]"
//   2. Values that are objects/arrays → recurse (regardless of key)
//   3. Scalar values with allowlisted keys → kept as-is
//   4. Scalar values with unknown keys → replaced with "[REDACTED]"
//
// Rule 2 sits above Rules 3-4 so nested PII inside allowlisted or unknown
// parent keys is still scrubbed. Rule 1 sits above Rule 2 so a PII key
// pointing at an object (e.g. { "email": { "primary": "x@y" } }) still
// redacts wholesale.

const PII_KEYS = new Set([
  "email", "phone", "phone_number",
  "contact_email", "contact_phone",
  "customer_email", "customer_phone",
  "given_name", "family_name", "middle_name",
  "passenger_name", "customer_name",
  "passport_number", "passport_no",
  "born_on", "dob", "date_of_birth",
  "authorization_code", "access_code",
]);

const ALLOWLIST_KEYS = new Set([
  "merchant_ref", "pending_booking_id", "booking_id",
  "duffel_order_id", "booking_reference",
  "paystack_tx_id", "alert_type", "error_code",
  "http_status", "timestamp",
  "retry_count", "attempt_number",
  "received_alert_type",  // S-02 fallback: preserve which unknown type came in
  // S-06 dispute-lifecycle operational fields (non-PII, non-secret) ─────
  "dispute_code",          // Paystack DISP_xxx identifier
  "dispute_reason",        // e.g. "unauthorized", "duplicate", "product-not-received"
  "dispute_outcome",       // "won" | "lost"
  "prior_status",          // bookings.status before the transition
  "flown",                 // boolean: has the flight already flown?
  "verify_status",         // Paystack verify endpoint status echo
  "verify_gateway_response",  // Paystack gateway_response echo
  "event_type",            // Paystack webhook event name (already used in refund alerts)
  "reference",             // Paystack transaction reference (echo of merchant_ref)
  "expected_kes",          // AMOUNT_MISMATCH context
  "received_kes",          // AMOUNT_MISMATCH context
  "webhook_amount_kes",    // AMOUNT_MISMATCH context
  "resend_error",          // S-02 email-failure branch preserves this
  "body_length",           // PAYSTACK_MALFORMED_WEBHOOK context
  "signature_header_present",  // PAYSTACK_SIGNATURE_FAILURE context
  "reason",                // generic reason string in many alerts
    "message",               // generic message string in many alerts
    "payload",               // nested payload (recursion will redact PII inside)
    // S-07 OTP throttle context (non-PII operational fields; hash is irreversible) ─
      "scope",                 // "phone" | "ip"
      "scope_value_sha256",    // SHA256 hash of phone or IP (irreversible)
      "window_minutes",        // rolling window size (integer)
      "limit",                 // throttle threshold (integer)
      "observed_count",        // count at time of trip (integer)
      // S-11 guest-token threshold context (non-PII operational fields) ─
      "attempt_count",         // guest_token_attempts value at threshold crossing (integer)
      "source_ip_hash",        // SHA256 hash of source IP (irreversible)
    ]);

export function redactContext(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(redactContext);
  if (typeof input !== "object") return input;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.toLowerCase();

    // Rule 1: PII keys always redact, regardless of value type.
    if (PII_KEYS.has(key)) {
      out[k] = "[REDACTED]";
      continue;
    }

    // Rule 2: Objects and arrays always recurse, regardless of key.
    if (v !== null && typeof v === "object") {
      out[k] = redactContext(v);
      continue;
    }

    // Rule 3: Allowlisted scalar keys pass through.
    if (ALLOWLIST_KEYS.has(key)) {
      out[k] = v;
      continue;
    }

    // Rule 4: Unknown scalar keys redact.
    out[k] = "[REDACTED]";
  }
  return out;
}
