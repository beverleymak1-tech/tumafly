// ============================================================================
// mint-guest-token — exchange (pending_booking_id, guest_token) for a scoped JWT
// ============================================================================
// Session 28c commit #10c.
//
// Purpose:
//   Anonymous customers on the #success page can't authenticate to Supabase
//   Realtime with a real auth session. This EF mints a short-lived,
//   narrowly-scoped JWT they can use instead. The JWT carries a
//   `guest_pending_booking_id` claim which the RLS policies (#10b) match
//   against pending_bookings.id and (indirectly) bookings.pending_booking_id
//   and booking_status_history.
//
// Security shape:
//   - The 64-char hex `guest_token` is the auth-establishing secret. Only
//     the customer's browser holds it (initialize-payment returns it once).
//   - We compare it in constant time against the DB row's guest_token.
//   - Failed comparisons increment pending_bookings.guest_token_attempts.
//     At 20, this row is refused further mints — bounds log noise and gives
//     us an ambient signal channel. Per-IP throttling is deliberately not
//     implemented — see Session 28c handoff for scaling trigger.
//   - JWTs are signed with AUTH_JWT_SECRET (same secret as normal auth
//     tokens), 24h expiry, `sub: "guest:<uuid>"` so they can never
//     accidentally satisfy `auth.uid()`-based policies.
//
// Endpoint contract:
//   POST /functions/v1/mint-guest-token
//   Body:  { pending_booking_id: uuid, guest_token: 64-char hex }
//   200:   { token: <jwt>, expires_at: <ISO8601> }
//   400:   malformed input
//   403:   token mismatch (counter incremented)
//   404:   pending_booking_id doesn't exist
//   429:   attempts >= threshold for this row
//   500:   server error

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { CORS_HEADERS } from "../_shared/duffel-helpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const AUTH_JWT_SECRET = Deno.env.get("AUTH_JWT_SECRET")!;

const MAX_ATTEMPTS = 20;
const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Prepare the JWT signing key once at cold-start.
// crypto.subtle.importKey is async so we can't do this at module top level
// synchronously — cache the promise instead.
const jwtKeyPromise = (async () => {
  const secretBytes = new TextEncoder().encode(AUTH_JWT_SECRET);
  return await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
})();

// Constant-time string comparison. Both strings must be the same length
// class (64 hex chars in our case) or we short-circuit on length — that
// leak is acceptable because token length is public information.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // Parse body
  let body: { pending_booking_id?: string; guest_token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { pending_booking_id, guest_token } = body;

  if (!pending_booking_id || typeof pending_booking_id !== "string" || !UUID_RE.test(pending_booking_id)) {
    return jsonResponse(400, { error: "pending_booking_id must be a UUID" });
  }
  if (!guest_token || typeof guest_token !== "string" || !HEX64_RE.test(guest_token)) {
    return jsonResponse(400, { error: "guest_token must be a 64-char hex string" });
  }

  // Look up the row (service_role bypasses RLS)
  const { data: pending, error: fetchErr } = await supabase
    .from("pending_bookings")
    .select("id, guest_token, guest_token_attempts")
    .eq("id", pending_booking_id)
    .maybeSingle();

  if (fetchErr) {
    console.error("[mint-guest-token] DB fetch error:", fetchErr);
    return jsonResponse(500, { error: "Server error" });
  }

  if (!pending) {
    // Note: this leaks "this UUID doesn't exist" as opposed to "the token
    // was wrong" — acceptable, UUIDs are 122 bits, non-guessable.
    return jsonResponse(404, { error: "Not found" });
  }

  // Threshold check BEFORE token comparison — a locked row can't even
  // be probed for whether the caller has the right token.
  if (pending.guest_token_attempts >= MAX_ATTEMPTS) {
    return jsonResponse(429, {
      error: "Too many failed attempts for this booking. Contact support.",
    });
  }

  // Handle the pathological case: a row with NULL guest_token. Shouldn't
  // happen post-#10a (backfill filled everything and initialize-payment
  // populates on every new INSERT) but defense-in-depth.
  if (!pending.guest_token) {
    console.error("[mint-guest-token] Row has NULL guest_token:", pending_booking_id);
    return jsonResponse(500, { error: "Server error" });
  }

  // Constant-time comparison
  if (!constantTimeEquals(guest_token, pending.guest_token)) {
    // Increment counter. Use a raw increment via update — race conditions
    // are fine here (worst case: two concurrent bad attempts increment by
    // one instead of two; still bounded by MAX_ATTEMPTS on the next check).
    const { error: updateErr } = await supabase
      .from("pending_bookings")
      .update({ guest_token_attempts: pending.guest_token_attempts + 1 })
      .eq("id", pending_booking_id);

    if (updateErr) {
      console.error("[mint-guest-token] Failed to increment attempts counter:", updateErr);
      // Don't fail the response — the 403 is still correct.
    }

    return jsonResponse(403, { error: "Invalid token" });
  }

  // Token matches — mint the JWT.
  const now = Math.floor(Date.now() / 1000);
  const exp = now + JWT_EXPIRY_SECONDS;

  const payload = {
    role: "authenticated",
    aud: "authenticated",
    iss: "supabase",
    // Realtime's internal apply_rls unconditionally casts sub to uuid
        // (Session 28c #10d debugging), so it must be a valid UUID. Safe because
        // the *_select_own RLS policies guard on guest_pending_booking_id IS NULL —
        // a guest JWT will never satisfy them regardless of what sub contains.
        sub: pending_booking_id,
    guest_pending_booking_id: pending_booking_id,
    iat: now,
    exp,
  };

  try {
    const key = await jwtKeyPromise;
    const jwt = await create({ alg: "HS256", typ: "JWT" }, payload, key);

    return jsonResponse(200, {
      token: jwt,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[mint-guest-token] JWT sign failure:", err);
    return jsonResponse(500, { error: "Server error" });
  }
});
