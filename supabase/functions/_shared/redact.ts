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
