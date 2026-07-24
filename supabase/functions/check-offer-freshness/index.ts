// ============================================================================
// check-offer-freshness — lightweight aliveness probe for a Duffel offer
// ============================================================================
// Session 28h. Called from the frontend `selectPayTab` handler at Card-row
// tap, BEFORE opening the Paystack modal. Defends against the (narrow but
// real) window between `initialize-payment` completing and Paystack modal
// opening, where Duffel may have invalidated the offer for non-time reasons
// (inventory sold, schedule change, fare withdrawn) that the time-based
// fare timer cannot detect.
//
// Uses POST /air/offers/{id}/actions/price with intended_payment_methods:
// [{ type: "balance" }] rather than plain GET. Per Duffel's "Getting An
// Accurate Price Before Booking" guide, this state-mutates the offer to
// remember the last intended payment methods; for balance flow with no
// surcharge/currency-shift concerns, the pricing outcome matches plain
// GET. If /actions/price catches offer-deaths plain GET wouldn't, this
// is where we'd observe it empirically.
//
// Contract compatibility: process-duffel-booking already sends
// `payments: [{ type: "balance", ... }]` at L303-307, so opting into
// Duffel's payments/intended-payment-methods matching contract is safe.
//
// Response shape:
//   - 200 { alive: true, expires_at, total_amount, total_currency }
//   - 410 { error, duffel_status, duffel_code }  — offer dead per Duffel
//                                                  or expires_at < 60s
//   - 502 { error, detail }                       — infra failure; caller
//                                                  should fall through to
//                                                  Paystack cache (fare
//                                                  timer + async refund
//                                                  still protect)
//
// Auth: anon key sufficient — this is a read-only aliveness probe with
// no PII exposure. Turnstile NOT required since this is a follow-up on
// an already-authenticated initialize-payment cycle.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY");
const DUFFEL_BASE_URL = "https://api.duffel.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

// Match initialize-payment's 60s cutoff — if Duffel-side runway is under
// 60s, the customer wouldn't be able to complete Paystack anyway.
const OFFER_EXPIRY_MIN_MS = 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: CORS_HEADERS },
    );
  }

  if (!DUFFEL_API_KEY) {
    console.error("[check-offer-freshness] DUFFEL_API_KEY not set");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: CORS_HEADERS },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return new Response(
      JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const offer_id = body?.offer_id;
  if (typeof offer_id !== "string" || !/^off_[A-Za-z0-9]+$/.test(offer_id)) {
    return new Response(
      JSON.stringify({ error: "Invalid or missing offer_id" }),
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // POST /air/offers/{id}/actions/price with balance intended_payment_methods.
  // For balance flow this is equivalent-in-outcome to plain GET (no surcharge,
  // no currency shift), but if Duffel treats /actions/price as a fresher
  // supplier-side check than GET, this is where we'd observe it empirically.
  let priceRes: Response;
  let priceData: any;
  try {
    priceRes = await fetch(
      `${DUFFEL_BASE_URL}/air/offers/${offer_id}/actions/price`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Content-Type": "application/json",
          "Duffel-Version": "v2",
          Accept: "application/json",
        },
        body: JSON.stringify({
          data: {
            intended_payment_methods: [{ type: "balance" }],
          },
        }),
      },
    );
    priceData = await priceRes.json();
  } catch (err) {
    console.error(
      "[check-offer-freshness] Duffel /actions/price threw:",
      err,
    );
    return new Response(
      JSON.stringify({
        error: "Freshness check failed",
        detail: (err as Error).message,
      }),
      { status: 502, headers: CORS_HEADERS },
    );
  }

  // Non-2xx from Duffel → treat as offer dead. Typically:
  //   - 404 if the offer_id doesn't exist
  //   - 422 offer_no_longer_available if the airline invalidated it
  //   - 4xx validation errors (shouldn't fire for a well-formed request)
  // All are 410-worthy from the frontend's POV (do not proceed).
  if (!priceRes.ok) {
    console.log(
      "[check-offer-freshness] Duffel non-2xx:",
      priceRes.status,
      JSON.stringify(priceData).slice(0, 500),
    );
    return new Response(
      JSON.stringify({
        error: "Offer no longer available",
        duffel_status: priceRes.status,
        duffel_code: priceData?.errors?.[0]?.code || null,
      }),
      { status: 410, headers: CORS_HEADERS },
    );
  }

  const offer = priceData?.data;
  if (!offer || !offer.expires_at || !offer.total_amount) {
    console.error(
      "[check-offer-freshness] Duffel returned unexpected shape:",
      JSON.stringify(priceData).slice(0, 500),
    );
    return new Response(
      JSON.stringify({ error: "Freshness check returned unexpected data" }),
      { status: 502, headers: CORS_HEADERS },
    );
  }

  const expiresAtMs = new Date(offer.expires_at).getTime();
  if (isNaN(expiresAtMs) || Date.now() > expiresAtMs - OFFER_EXPIRY_MIN_MS) {
    return new Response(
      JSON.stringify({
        error: "Offer is about to expire",
        expires_at: offer.expires_at,
      }),
      { status: 410, headers: CORS_HEADERS },
    );
  }

  return new Response(
    JSON.stringify({
      alive: true,
      expires_at: offer.expires_at,
      total_amount: offer.total_amount,
      total_currency: offer.total_currency,
    }),
    { status: 200, headers: CORS_HEADERS },
  );
});