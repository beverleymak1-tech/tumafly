// _shared/redact.ts — v2 (Session 35b, Architecture B)
// Boundary-only redaction for the alerts pipeline.
//
// Design (see TumaFly_Session35b_Design_Audit.md §2.1-2):
//   Architecture B: redact at trust-boundary crossings, not at DB insert.
//   The alerts table itself is inside the trust boundary (RLS deny-all +
//   service-role-only + encrypted-at-rest + 365d retention). Raw context
//   preserved there enables §26 data-subject access, RTBF Stage 4
//   anonymization, and forensic incident reconstruction. Redaction happens
//   only on the outbound email render (crosses to Resend + inbox).
//
// Two categories, applied recursively via walk():
//   SECRET_KEYS  — payment/auth credentials with high blast radius.
//                   Redacted in BOTH email and audit paths. Never needed
//                   anywhere in the alerts pipeline; defense-in-depth.
//   PII_KEYS     — personal identifiers (email/phone/passport/DOB/names).
//                   Redacted in email path ONLY. Preserved in audit path
//                   because §26 access + RTBF Stage 4 + incident forensics
//                   all require identifier-to-alert mapping capability.
//
// Rule order (per key/value pair):
//   A. key in SECRET_KEYS         → "[REDACTED]", regardless of value type
//   B. key in PII_KEYS (email mode only) → "[REDACTED]", regardless of value type
//   C. value is object/array      → recurse
//   D. default                    → passthrough
//
// Rule A above B: correct handling of edge case { authorization_code: {...} }.
// Rule B above C: correct handling of nested { contact: { email: "..." } }.
// Rule C above D: unknown-shaped nested objects still get walked so nested
//                 SECRETS + PII get caught by rules A/B one level deeper.
//
// Drift-warning heuristic: any scalar key matching a broad SECRET pattern
// that is NOT in SECRET_KEYS emits a console.warn (never the value, only
// the key name + call site marker). Zero behavior change — passive drift
// visibility so a Session-33-class allowlist-drift can't recur silently.

// ── SECRET_KEYS ──────────────────────────────────────────────────────────
// Redacted in both email and audit paths.
const SECRET_KEYS = new Set([
  "authorization_code",   // Paystack reusable card-charge token (nests inside verify_response.data.authorization)
  "access_code",          // Paystack transaction session code
  "password",
  "token",                // generic bearer/auth tokens
  "secret",
  "api_key",
  "bearer",
]);

// ── PII_KEYS ─────────────────────────────────────────────────────────────
// Redacted in email path only. Preserved in audit path.
// Includes aliases for Paystack/Turnstile/legacy shapes (first_name/last_name)
// alongside Duffel's given_name/family_name.
//
// Semantically-loaded schema names — added Session 35b Phase 4 after real
// LHR-LGW verification exposed passport-number leak via Duffel's schema:
//   - unique_identifier is Duffel's field for passport/ID number when nested
//     under identity_documents[]. Also used for TICKET numbers (electronic
//     ticket documents), but callers who need those always transform to a
//     ticket_numbers array before passing to alerts, so blanket-redaction
//     here is safe.
//   - account_number is the loyalty-programme identifier inside
//     loyalty_programme_accounts[]. Not currently in any alert context but
//     added defensively — future alerts dumping a full Duffel passenger
//     object would leak it otherwise.
//   - expires_on and issuing_country_code are the remaining identity_documents
//     fields. Codebase-wide grep confirms both appear ONLY in identity_documents
//     context (no offer.expires_on or other non-PII usage in this repo).
//   - nationality and gender are passenger-level fields. Nationality is
//     country-level PII (ODPC Article 25 minimisation applies); gender is a
//     protected characteristic (ODPC §2 special-category-adjacent). Grep
//     confirms nationality has zero other usages; gender appears only in
//     passenger-mapping code.
//
// DELIBERATELY NOT added despite being passenger-level:
//   - title: cross-cutting. Used for Duffel error tree titles ("Unexpected
//     Airline Error") and Paystack error titles — actionable operational
//     fields in real PAID_NO_TICKET emails. Scrubbing would cause CS regression.
//   - type: cross-cutting. Used for passenger.type ("adult"), identity_document.type
//     ("passport"), duffel_error.errors[].type ("airline_error"), and
//     documents[].type ("electronic_ticket"). All operational.
const PII_KEYS = new Set([
  "email", "phone", "phone_number",
  "contact_email", "contact_phone",
  "customer_email", "customer_phone",
  "given_name", "family_name", "middle_name",
  "first_name", "last_name", "full_name",
  "passenger_name", "customer_name",
  "passport_number", "passport_no",
  "unique_identifier",     // Duffel: passport/ID number inside identity_documents[]
  "account_number",        // Duffel: loyalty programme identifier
  "expires_on",            // Duffel: identity_document expiry date
  "issuing_country_code",  // Duffel: identity_document issuing country
  "nationality",           // Duffel: passenger nationality (country-level PII)
  "gender",                // Duffel: passenger gender (protected characteristic)
  "born_on", "dob", "date_of_birth", "birthdate",
]);

// ── Drift-warning heuristic ──────────────────────────────────────────────
// Matches keys likely to hold a credential. Used ONLY for a console.warn on
// keys that AREN'T in SECRET_KEYS but look like they could hold one — passive
// signal to review whether SECRET_KEYS needs extending. NEVER used to redact
// (avoids false-positive scrubbing of e.g. dedup_key, merchant_ref, email_id).
const SECRET_LOOKING = /(secret|token|password|api[_-]?key|bearer|credential|auth[_-]?code)/i;

// Known-safe exceptions to the heuristic (would otherwise trigger warns).
const SECRET_HEURISTIC_EXCEPTIONS = new Set([
  "dedup_key",           // alerts dedup framework
  "merchant_ref_key",    // hypothetical — reserved
  "phone_sha256",        // hashed, not a secret
  "source_ip_hash",      // hashed, not a secret
  "scope_value_sha256",  // hashed, not a secret
  "webhook_secret_header_present",  // boolean marker, not the secret itself
]);

function walk(input: unknown, stripPII: boolean): unknown {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => walk(v, stripPII));
  if (typeof input !== "object") return input;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.toLowerCase();

    // Rule A: secrets always redact
    if (SECRET_KEYS.has(key)) { out[k] = "[REDACTED]"; continue; }

    // Passive drift-warn: scalar key matches SECRET pattern but isn't listed
    if (
      typeof v !== "object" &&
      SECRET_LOOKING.test(key) &&
      !SECRET_HEURISTIC_EXCEPTIONS.has(key)
    ) {
      console.warn(`[redact] Possible undeclared SECRET-shaped key: "${k}" — review SECRET_KEYS in _shared/redact.ts`);
    }

    // Rule B: PII redacts on email path only
    if (stripPII && PII_KEYS.has(key)) { out[k] = "[REDACTED]"; continue; }

    // Rule C: recurse into objects/arrays
    if (v !== null && typeof v === "object") { out[k] = walk(v, stripPII); continue; }

    // Rule D: passthrough
    out[k] = v;
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Full scrub for outbound email (SECRET_KEYS + PII_KEYS + recursion). */
export function redactForEmail(input: unknown): unknown {
  return walk(input, true);
}

/** Audit-row scrub (SECRET_KEYS + recursion only). PII preserved for
 *  §26 access, RTBF Stage 4, and forensic reconstruction. */
export function redactForAudit(input: unknown): unknown {
  return walk(input, false);
}

/** @deprecated — use redactForEmail. Kept transiently for backward compat
 *  during Session 35b/c rollout. Will be removed once no import remains. */
export function redactContext(input: unknown): unknown {
  return redactForEmail(input);
}