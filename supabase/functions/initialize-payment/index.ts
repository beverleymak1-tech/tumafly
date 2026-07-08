// ============================================================================
// initialize-payment — Paystack equivalent of create-payment
// ============================================================================
// Mirrors create-payment (Pesapal) structurally so both can be reviewed
// side-by-side. Preserves:
//   - Duffel mode/key mismatch guard + alertFounder pattern
//   - Email + E.164 phone validation
//   - Turnstile bot protection
//   - Offer re-fetch + price drift check
//   - Seat + baggage validation with sandbox soft-skip
//   - pending_bookings schema (merchant_ref stored in pesapal_order_id column
//     until we rename it in a future migration — both processors use it)
//
// Only Pesapal-specific bits are replaced:
//   - Env vars: PAYSTACK_API_KEY / PAYSTACK_MODE instead of PESAPAL_*
//   - Fee model: 1.95% + KES 30 flat instead of Pesapal's 3.5%
//   - Order call: Paystack POST /transaction/initialize instead of
//     Pesapal SubmitOrderRequest
//   - Response: returns { access_code } for InlineJS resumeTransaction
//     instead of { redirect_url } for iframe embed
//
// The paystack-webhook EF (separate file) handles the downstream chain
// (Duffel order + eTicket email) — same as pesapal-webhook does today.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
// "sandbox" or "production". Defaults to production for fail-closed safety.
const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

// Paystack — single-key mode for now. At live cutover, either overwrite
// PAYSTACK_API_KEY with the sk_live_... value, or split into
// PAYSTACK_API_KEY_TEST + PAYSTACK_API_KEY_LIVE and switch on PAYSTACK_MODE.
// See handoff cutover notes.
const PAYSTACK_API_KEY = Deno.env.get("PAYSTACK_API_KEY")!;
const PAYSTACK_MODE = (Deno.env.get("PAYSTACK_MODE") || "test").toLowerCase();
const PAYSTACK_BASE_URL = "https://api.paystack.co";

const FRONTEND_URL = Deno.env.get("FRONTEND_URL")!;
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET") || "";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// TumaFly's flat service fee, in KES (your margin — unchanged from Pesapal EF)
const TUMAFLY_SERVICE_FEE_KES = 1500;

// ── Paystack fee model (Kenya cards) ──────────────────────────────────────
// 1.95% + KES 30 flat per successful transaction.
// Charged on the gross amount Paystack receives, so we gross-up:
//   grossCharge such that grossCharge * (1 - PAYSTACK_FEE_RATE) - flat = subtotal
//   grossCharge = (subtotal + flat) / (1 - PAYSTACK_FEE_RATE)
//   processingFee = grossCharge - subtotal
// This ensures subtotal + processingFee - actualPaystackFee == subtotal
// (we net our full subtotal).
//
// If Paystack quotes you a different rate on your final merchant contract
// (volume-based negotiation, custom terms), update these two constants.
const PAYSTACK_FEE_RATE = 0.0195;
const PAYSTACK_FEE_FLAT_KES = 30;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ── Mode/key mismatch guard ───────────────────────────────────────────────
// Fires once at cold start if DUFFEL_MODE or PAYSTACK_MODE doesn't match the
// key prefix. All requests refused with 503 + one CRITICAL alert per cold
// start. Same pattern as create-payment / get-baggage-options / etc.
let MODE_KEY_OK = true;
let MODE_KEY_REASON = "";
{
  const isDuffelTest = DUFFEL_API_KEY.startsWith("duffel_test_");
  const isDuffelLive = DUFFEL_API_KEY.startsWith("duffel_live_");
  const isPaystackTest = PAYSTACK_API_KEY.startsWith("sk_test_");
  const isPaystackLive = PAYSTACK_API_KEY.startsWith("sk_live_");

  if (!DUFFEL_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_API_KEY not set";
  } else if (!PAYSTACK_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_API_KEY not set";
  } else if (DUFFEL_MODE === "sandbox" && !isDuffelTest) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_MODE=sandbox but DUFFEL_API_KEY is not a test key";
  } else if (DUFFEL_MODE === "production" && !isDuffelLive) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_MODE=production but DUFFEL_API_KEY is not a live key";
  } else if (DUFFEL_MODE !== "sandbox" && DUFFEL_MODE !== "production") {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `DUFFEL_MODE has unexpected value: "${DUFFEL_MODE}"`;
  } else if (PAYSTACK_MODE === "test" && !isPaystackTest) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_MODE=test but PAYSTACK_API_KEY is not a test key";
  } else if (PAYSTACK_MODE === "live" && !isPaystackLive) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_MODE=live but PAYSTACK_API_KEY is not a live key";
  } else if (PAYSTACK_MODE !== "test" && PAYSTACK_MODE !== "live") {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `PAYSTACK_MODE has unexpected value: "${PAYSTACK_MODE}"`;
  }
}
let modeKeyAlertFired = false;

async function alertFounder(alertType: string, context: Record<string, unknown>) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/alert-founder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ alert_type: alertType, context }),
    });
  } catch (_) { /* swallow — alerts must never block */ }
}

async function checkModeKeyMismatch(source: string): Promise<Response | null> {
  if (MODE_KEY_OK) return null;
  if (!modeKeyAlertFired) {
    modeKeyAlertFired = true;
    await alertFounder("PAYSTACK_OR_DUFFEL_MODE_KEY_MISMATCH", { source, reason: MODE_KEY_REASON });
  }
  return new Response(
    JSON.stringify({ error: "Service temporarily unavailable. Please try again shortly." }),
    { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

// ── Phone validation (identical to create-payment) ────────────────────────
const DIAL_DIGIT_COUNTS: Record<string, [number, number]> = {
  "254":[9,9], "256":[9,9], "255":[9,9], "250":[9,9], "251":[9,9],
  "27":[9,9], "234":[10,10], "233":[9,9], "20":[10,10], "212":[9,9],
  "243":[9,9], "221":[9,9], "225":[10,10], "237":[9,9], "260":[9,9],
  "263":[9,9], "267":[8,8], "230":[8,8], "264":[9,9], "258":[9,9],
  "261":[9,9], "265":[9,9], "244":[9,9], "257":[8,8], "211":[9,9],
  "252":[9,9], "253":[8,8], "291":[7,7], "249":[9,9], "216":[8,8],
  "213":[9,9], "218":[9,9], "223":[8,8], "226":[8,8], "227":[8,8],
  "235":[8,8], "222":[8,8], "220":[7,7], "224":[9,9], "245":[7,7],
  "232":[8,8], "231":[8,8], "228":[8,8], "229":[8,8], "242":[9,9],
  "241":[8,8], "236":[8,8], "240":[9,9], "239":[7,7], "238":[7,7],
  "269":[7,7], "248":[7,7], "266":[8,8], "268":[8,8],
  "971":[9,9], "974":[8,8], "966":[9,9], "965":[8,8], "973":[8,8],
  "968":[8,8], "962":[9,9], "961":[8,8], "972":[9,9], "970":[9,9],
  "964":[10,10], "963":[9,9], "967":[9,9], "98":[10,10], "90":[10,10],
  "44":[10,10], "353":[9,9], "33":[9,9], "49":[9,11], "34":[9,9],
  "39":[9,10], "351":[9,9], "31":[9,9], "32":[9,9], "352":[9,10],
  "41":[9,9], "43":[10,11], "45":[8,8], "46":[8,10], "47":[8,8],
  "358":[9,10], "354":[7,7], "48":[9,9], "420":[9,9], "421":[9,9],
  "36":[9,9], "40":[9,9], "359":[9,9], "30":[10,10], "357":[8,8],
  "356":[8,8], "381":[9,9], "385":[8,9], "386":[8,8], "387":[8,8],
  "382":[8,8], "389":[8,8], "355":[9,9], "383":[8,8], "372":[7,8],
  "371":[8,8], "370":[8,8], "375":[9,9], "380":[9,9], "373":[8,8],
  "7":[10,10], "995":[9,9], "374":[8,8], "994":[9,9],
  "1":[10,10], "52":[10,10], "55":[10,11], "54":[10,10], "56":[9,9],
  "57":[10,10], "51":[9,9], "58":[10,10], "593":[9,9], "591":[8,8],
  "595":[9,9], "598":[8,9], "506":[8,8], "507":[8,8], "502":[8,8],
  "504":[8,8], "503":[8,8], "505":[8,8], "53":[8,8], "509":[8,8],
  "86":[11,11], "852":[8,8], "853":[8,8], "886":[9,9], "81":[10,11],
  "82":[10,11], "976":[8,8], "91":[10,10], "92":[10,10], "880":[10,10],
  "94":[9,9], "960":[7,7], "977":[10,10], "975":[8,8], "93":[9,9],
  "66":[9,9], "84":[9,10], "856":[9,9], "855":[8,9], "95":[9,10],
  "60":[9,10], "65":[8,8], "62":[9,12], "63":[10,10], "673":[7,7],
  "998":[9,9], "996":[9,9], "992":[9,9], "993":[8,8],
  "61":[9,9], "64":[8,9], "679":[7,7], "675":[8,8],
};

function validateE164(phone: string): string | null {
  if (!phone || typeof phone !== "string") return "Invalid phone number.";
  if (!phone.startsWith("+")) return "Invalid phone number.";
  const digits = phone.slice(1).replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return "Invalid phone number.";
  for (let len = 4; len >= 1; len--) {
    const candidate = digits.slice(0, len);
    if (DIAL_DIGIT_COUNTS[candidate]) {
      const [min, max] = DIAL_DIGIT_COUNTS[candidate];
      const body = digits.slice(len);
      return (body.length < min || body.length > max) ? "Invalid phone number." : null;
    }
  }
  return digits.length < 7 ? "Invalid phone number." : null;
}

// ── Email validation (identical to create-payment) ────────────────────────
function validateEmail(email: string): string | null {
  if (!email || typeof email !== "string") return "Invalid email address.";
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return "Invalid email address.";
  const re = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
  if (!re.test(trimmed)) return "Invalid email address.";
  const [local, domain] = trimmed.split("@");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "Invalid email address.";
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return "Invalid email address.";
  return null;
}

// ── Turnstile verification (identical to create-payment) ──────────────────
async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true; // fail-open when not configured
  if (!token) return false;
  const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (!data.success) console.warn("Turnstile verification failed:", data["error-codes"]);
    return !!data.success;
  } catch (e) {
    console.error("Turnstile siteverify network error:", e);
    return false;
  }
}

async function toKES(amount: number, fromCurrency: string): Promise<number> {
  if (fromCurrency === "KES") return Math.round(amount);
  try {
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${fromCurrency}`);
    const data = await res.json();
    const rate = data.rates?.KES;
    if (rate) return Math.round(amount * rate);
  } catch {}
  return Math.round(amount * (FALLBACK_RATES[fromCurrency] || 130));
}

// ── Handler ───────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const guardBlock = await checkModeKeyMismatch("initialize-payment");
  if (guardBlock) return guardBlock;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Resolve user_id from JWT (guest if none)
  let userId: string | null = null;
  const incomingAuth = req.headers.get("Authorization") || "";
  if (incomingAuth.startsWith("Bearer ")) {
    const userJwt = incomingAuth.slice(7);
    if (userJwt && userJwt !== SERVICE_ROLE_KEY) {
      try {
        const { data: { user } } = await supabase.auth.getUser(userJwt);
        if (user) userId = user.id;
      } catch (_) { /* guest — leave null */ }
    }
  }

  try {
    const { offer_id, passengers, contact, seats, baggages, turnstile_token, expected_price_kes } = await req.json();

    // 1. Validate required fields
    if (!offer_id || !passengers?.length || !contact?.email) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1a. Email format
    const emailErr = validateEmail(contact.email);
    if (emailErr) {
      return new Response(JSON.stringify({ error: emailErr }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1b. E.164 phone (Paystack requires a valid phone for M-Pesa; we validate
    // for cards too since it's stored on the booking record)
    const phoneErr = validateE164(contact.phone_number || "");
    if (phoneErr) {
      return new Response(JSON.stringify({ error: phoneErr }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1c. Turnstile
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || undefined;
    const passesTurnstile = await verifyTurnstileToken(turnstile_token || "", clientIp);
    if (!passesTurnstile) {
      return new Response(JSON.stringify({
        error: "Verification failed. Please refresh the page and try again.",
      }), {
        status: 403,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 2. Re-fetch offer (unchanged from create-payment)
    const offerRes = await fetch(`${DUFFEL_BASE_URL}/air/offers/${offer_id}?return_available_services=true`, {
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
      },
    });
    const offerData = await offerRes.json();
    if (!offerRes.ok) {
      return new Response(JSON.stringify({
        error: "Offer no longer available. Please search again.",
        duffel_error: offerData,
      }), {
        status: 410,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const offer = offerData.data;
    const expiresAt = new Date(offer.expires_at).getTime();
    if (Date.now() > expiresAt - 60000) {
      return new Response(JSON.stringify({
        error: "Offer is about to expire. Please search again.",
      }), {
        status: 410,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 3. Price calc — base
    const baseAmountKES = await toKES(
      parseFloat(offer.total_amount),
      offer.total_currency
    );

    // 3z. Price-drift check (unchanged from create-payment)
    if (typeof expected_price_kes === "number" && expected_price_kes > 0) {
      const deltaKES = baseAmountKES - expected_price_kes;
      const deltaPct = Math.abs(deltaKES) / expected_price_kes;
      console.log("[initialize-payment] price drift check", {
        offer_id,
        expected_kes: expected_price_kes,
        actual_kes: baseAmountKES,
        delta_kes: deltaKES,
        delta_pct: (deltaPct * 100).toFixed(2) + "%",
        triggered: deltaPct > 0.01,
      });
      if (deltaPct > 0.01) {
        return new Response(JSON.stringify({
          code: "PRICE_DRIFT",
          expected_kes: expected_price_kes,
          actual_kes: baseAmountKES,
          delta_kes: deltaKES,
          error: "The fare price has changed.",
        }), {
          status: 409,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // 3a. Seat validation (unchanged from create-payment)
    type ValidatedSeat = {
      passenger_index: number;
      service_id: string;
      segment_id: string;
      designator: string;
      cost_kes: number;
      original_amount: string;
      original_currency: string;
    };
    let validatedSeats: ValidatedSeat[] = [];
    let seatsTotalKES = 0;
    if (Array.isArray(seats) && seats.length > 0) {
      const smRes = await fetch(`${DUFFEL_BASE_URL}/air/seat_maps?offer_id=${offer_id}`, {
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Duffel-Version": "v2",
          Accept: "application/json",
        },
      });
      const smData = await smRes.json();
      if (!smRes.ok) {
        return new Response(JSON.stringify({
          code: "STALE_SEAT",
          error: "Seat selection no longer available. Please reselect seats.",
        }), {
          status: 409,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      const serviceLookup: Record<string, { segment_id: string; amount: string; currency: string }> = {};
      for (const segMap of (smData.data || [])) {
        for (const cabin of (segMap.cabins || [])) {
          for (const row of (cabin.rows || [])) {
            for (const section of (row.sections || [])) {
              for (const el of (section.elements || [])) {
                if (el.type !== "seat") continue;
                for (const svc of (el.available_services || [])) {
                  serviceLookup[svc.id] = {
                    segment_id: segMap.segment_id,
                    amount: svc.total_amount,
                    currency: svc.total_currency,
                  };
                }
              }
            }
          }
        }
      }
      for (const s of seats) {
        if (!s.service_id) continue;
        const svc = serviceLookup[s.service_id];
        if (!svc) {
          if (DUFFEL_MODE === "sandbox") {
            console.warn("Seat service not re-found (sandbox soft-skip):", s.service_id, s.designator);
            continue;
          }
          return new Response(JSON.stringify({
            code: "STALE_SEAT",
            error: `Seat ${s.designator || "?"} is no longer available. Please reselect.`,
          }), {
            status: 409,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const kes = await toKES(parseFloat(svc.amount), svc.currency);
        seatsTotalKES += kes;
        validatedSeats.push({
          passenger_index: s.passenger_index,
          service_id: s.service_id,
          segment_id: svc.segment_id,
          designator: s.designator,
          cost_kes: kes,
          original_amount: svc.amount,
          original_currency: svc.currency,
        });
      }
    }

    // 3b. Baggage validation (unchanged from create-payment)
    type ValidatedBaggage = {
      passenger_index: number;
      service_id: string;
      quantity: number;
      cost_kes: number;
      total_kes: number;
      original_amount: string;
      original_currency: string;
      bag_type?: string;
      weight_kg?: number | null;
    };
    let validatedBaggages: ValidatedBaggage[] = [];
    let baggageTotalKES = 0;
    if (Array.isArray(baggages) && baggages.length > 0) {
      const allServices: any[] = Array.isArray(offer.available_services)
        ? offer.available_services
        : [];
      const baggageLookup: Record<string, {
        amount: string;
        currency: string;
        max_quantity: number;
        passenger_ids: string[];
        metadata: any;
      }> = {};
      for (const svc of allServices) {
        if (svc?.type !== "baggage") continue;
        const maxQ = Number(svc.maximum_quantity ?? svc.metadata?.maximum_quantity ?? 1) || 1;
        baggageLookup[svc.id] = {
          amount: svc.total_amount,
          currency: svc.total_currency,
          max_quantity: Math.max(1, Math.min(maxQ, 10)),
          passenger_ids: Array.isArray(svc.passenger_ids) ? svc.passenger_ids : [],
          metadata: svc.metadata || {},
        };
      }
      for (const b of baggages) {
        if (!b?.service_id) continue;
        const qty = Number(b.quantity) || 0;
        if (qty <= 0) continue;
        const svc = baggageLookup[b.service_id];
        if (!svc) {
          if (DUFFEL_MODE === "sandbox") {
            console.warn("Baggage service not re-found (sandbox soft-skip):", b.service_id);
            continue;
          }
          return new Response(JSON.stringify({
            code: "STALE_BAGGAGE",
            error: "A baggage selection is no longer available. Please reselect.",
          }), {
            status: 409,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const boundedQty = Math.min(qty, svc.max_quantity);
        if (boundedQty !== qty) {
          console.warn("Baggage qty capped:", b.service_id, qty, "→", boundedQty);
        }
        const duffelPaxId = offer.passengers?.[b.passenger_index]?.id;
        if (duffelPaxId && svc.passenger_ids.length > 0 && !svc.passenger_ids.includes(duffelPaxId)) {
          if (DUFFEL_MODE === "sandbox") {
            console.warn("Baggage svc not offered for pax (sandbox soft-skip):", b.service_id, duffelPaxId);
            continue;
          }
          return new Response(JSON.stringify({
            error: "A baggage selection isn't valid for the selected passenger. Please reselect.",
          }), {
            status: 409,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const perUnitKES = await toKES(parseFloat(svc.amount), svc.currency);
        const lineKES = perUnitKES * boundedQty;
        baggageTotalKES += lineKES;
        validatedBaggages.push({
          passenger_index: b.passenger_index,
          service_id: b.service_id,
          quantity: boundedQty,
          cost_kes: perUnitKES,
          total_kes: lineKES,
          original_amount: svc.amount,
          original_currency: svc.currency,
          bag_type: svc.metadata?.type || "checked",
          weight_kg: svc.metadata?.maximum_weight_kg ?? null,
        });
      }
    }

    // 3c. Roll costs together — same conventions as create-payment
    const baseWithSeatsKES = baseAmountKES + seatsTotalKES;
    const subtotal = baseWithSeatsKES + baggageTotalKES + TUMAFLY_SERVICE_FEE_KES;

    // Paystack gross-up: 1.95% + 30 KES flat
    // grossCharge = (subtotal + flat) / (1 - rate)
    // processingFee = grossCharge - subtotal
    const grossCharge = Math.ceil(
      (subtotal + PAYSTACK_FEE_FLAT_KES) / (1 - PAYSTACK_FEE_RATE)
    );
    const processingFeeKES = grossCharge - subtotal;
    const totalKES = grossCharge;

    // 4. Insert pending_booking BEFORE Paystack call
    // merchant_ref is our reference — Paystack echoes it back on webhook.
    // Reusing the pesapal_order_id column for now (rename in future migration).
    const merchantRef = `TF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const contactWithSeats = { ...contact, seats: validatedSeats, baggages: validatedBaggages };

    const { data: pending, error: insertErr } = await supabase
      .from("pending_bookings")
      .insert({
        user_id: userId,
        pesapal_order_id: merchantRef, // reused column — same value across both processors
        duffel_offer_id: offer_id,
        passengers,
        contact: contactWithSeats,
        base_amount_kes: baseWithSeatsKES + baggageTotalKES,
        service_fee_kes: TUMAFLY_SERVICE_FEE_KES,
        processing_fee_kes: processingFeeKES,
        total_kes: totalKES,
        payment_method: "pending", // set by webhook after Paystack confirms
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

    // 5. Call Paystack Initialize Transaction
    // Paystack expects amounts in the smallest currency unit (KES × 100 = cents/kobo).
    // Ref: https://paystack.com/docs/payments/accept-payments/#initialize-transaction
    const paystackAmount = totalKES * 100;
    const paystackRes = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: contact.email,
        amount: paystackAmount,
        currency: "KES",
        reference: merchantRef,
        callback_url: `${FRONTEND_URL}/?ref=${merchantRef}`,
        channels: ["card"], // cards only for launch — M-Pesa via Daraja later
        metadata: {
          pending_booking_id: pending.id,
          duffel_offer_id: offer_id,
          user_id: userId,
          custom_fields: [
            {
              display_name: "Booking Reference",
              variable_name: "booking_reference",
              value: merchantRef,
            },
            {
              display_name: "Route",
              variable_name: "route",
              value: `${offer.slices[0].origin.iata_code} → ${offer.slices[offer.slices.length - 1].destination.iata_code}`,
            },
          ],
        },
      }),
    });

    const paystackData = await paystackRes.json();
    if (!paystackRes.ok || !paystackData.status || !paystackData.data?.access_code) {
      await supabase
        .from("pending_bookings")
        .update({ status: "failed_to_create" })
        .eq("id", pending.id);
      throw new Error(`Paystack init failed: ${JSON.stringify(paystackData)}`);
    }

    // 6. Response — return access_code for InlineJS resumeTransaction
    return new Response(JSON.stringify({
      success: true,
      access_code: paystackData.data.access_code,
      authorization_url: paystackData.data.authorization_url, // fallback if InlineJS fails
      merchant_ref: merchantRef,
      breakdown: {
        base_kes: baseAmountKES,
        seats_kes: seatsTotalKES,
        baggage_kes: baggageTotalKES,
        service_fee_kes: TUMAFLY_SERVICE_FEE_KES,
        processing_fee_kes: processingFeeKES,
        total_kes: totalKES,
      },
    }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("initialize-payment error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});