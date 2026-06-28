import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
// "sandbox" or "production". Defaults to production for fail-closed safety —
// must be explicitly set to "sandbox" to enable the seat-service soft-skip path
// (Duffel's sandbox doesn't always re-issue seat services consistently between
// the seat-map and order endpoints, which would otherwise block test bookings).
const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const PESAPAL_BASE_URL = Deno.env.get("PESAPAL_BASE_URL")!;
const PESAPAL_CONSUMER_KEY = Deno.env.get("PESAPAL_CONSUMER_KEY")!;
const PESAPAL_CONSUMER_SECRET = Deno.env.get("PESAPAL_CONSUMER_SECRET")!;
const PESAPAL_IPN_ID = Deno.env.get("PESAPAL_IPN_ID")!;
const FRONTEND_URL = Deno.env.get("FRONTEND_URL")!;
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET") || "";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// TumaFly's flat service fee, in KES (your margin)
const TUMAFLY_SERVICE_FEE_KES = 1500;

// Pesapal's flat merchant fee — 3.5% on M-Pesa and cards.
// Passed through to customer as a separate line item.
// Fee is charged on the GROSS amount Pesapal receives, so we must gross-up:
//   processingFee = subtotal * rate / (1 - rate)
// This ensures subtotal + processingFee - (gross * rate) == subtotal (we net our full subtotal).
const PESAPAL_FEE_RATE = 0.035;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ── Mode/key mismatch guard ───────────────────────────────────────────────
// Fires once at cold start if DUFFEL_MODE doesn't match the key prefix.
// All requests refused with 503 + one CRITICAL alert per cold start. Catches
// the launch-day disaster where mode is left as sandbox after key swap (or
// vice versa). Mirrors the same guard in get-baggage-options, pesapal-webhook,
// and mpesa-callback.
let MODE_KEY_OK = true;
let MODE_KEY_REASON = "";
{
  const isTestKey = DUFFEL_API_KEY.startsWith("duffel_test_");
  const isLiveKey = DUFFEL_API_KEY.startsWith("duffel_live_");
  if (!DUFFEL_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_API_KEY not set";
  } else if (DUFFEL_MODE === "sandbox" && !isTestKey) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_MODE=sandbox but DUFFEL_API_KEY is not a test key";
  } else if (DUFFEL_MODE === "production" && !isLiveKey) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_MODE=production but DUFFEL_API_KEY is not a live key";
  } else if (DUFFEL_MODE !== "sandbox" && DUFFEL_MODE !== "production") {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `DUFFEL_MODE has unexpected value: "${DUFFEL_MODE}"`;
  }
}
let modeKeyAlertFired = false;

// Fire-and-forget alert helper. Calls alert-founder Edge Function so the
// founder gets an email with full context. Never blocks the response path.
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

// Helper used at the top of the request handler. Returns a Response (the 503)
// when there's a mismatch — caller bails on it. Returns null when guard passes.
async function checkDuffelModeKeyMismatch(
  _alertFn: typeof alertFounder,
  source: string,
): Promise<Response | null> {
  if (MODE_KEY_OK) return null;
  if (!modeKeyAlertFired) {
    modeKeyAlertFired = true;
    await alertFounder("DUFFEL_MODE_KEY_MISMATCH", { source, reason: MODE_KEY_REASON });
  }
  return new Response(
    JSON.stringify({ error: "Service temporarily unavailable. Please try again shortly." }),
    { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

// ── Phone validation ──────────────────────────────────────────────────────
// Server-side belt-and-suspenders mirror of the frontend's validatePhoneLocal.
// Parses dial code straight from the E.164 string (longest-first match) so we
// don't need the client to send a separate iso. Where multiple countries share
// a dial code (+1, +7, +212) we use a single range that fits all of them.
// Returns null if OK, error string otherwise.
const DIAL_DIGIT_COUNTS: Record<string, [number, number]> = {
  // Africa
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
  // Middle East
  "971":[9,9], "974":[8,8], "966":[9,9], "965":[8,8], "973":[8,8],
  "968":[8,8], "962":[9,9], "961":[8,8], "972":[9,9], "970":[9,9],
  "964":[10,10], "963":[9,9], "967":[9,9], "98":[10,10], "90":[10,10],
  // Europe
  "44":[10,10], "353":[9,9], "33":[9,9], "49":[9,11], "34":[9,9],
  "39":[9,10], "351":[9,9], "31":[9,9], "32":[9,9], "352":[9,10],
  "41":[9,9], "43":[10,11], "45":[8,8], "46":[8,10], "47":[8,8],
  "358":[9,10], "354":[7,7], "48":[9,9], "420":[9,9], "421":[9,9],
  "36":[9,9], "40":[9,9], "359":[9,9], "30":[10,10], "357":[8,8],
  "356":[8,8], "381":[9,9], "385":[8,9], "386":[8,8], "387":[8,8],
  "382":[8,8], "389":[8,8], "355":[9,9], "383":[8,8], "372":[7,8],
  "371":[8,8], "370":[8,8], "375":[9,9], "380":[9,9], "373":[8,8],
  "7":[10,10], "995":[9,9], "374":[8,8], "994":[9,9],
  // Americas (note: +1 covers all NANP — US/CA/JM/BS/etc all 10 digits)
  "1":[10,10], "52":[10,10], "55":[10,11], "54":[10,10], "56":[9,9],
  "57":[10,10], "51":[9,9], "58":[10,10], "593":[9,9], "591":[8,8],
  "595":[9,9], "598":[8,9], "506":[8,8], "507":[8,8], "502":[8,8],
  "504":[8,8], "503":[8,8], "505":[8,8], "53":[8,8], "509":[8,8],
  // Asia
  "86":[11,11], "852":[8,8], "853":[8,8], "886":[9,9], "81":[10,11],
  "82":[10,11], "976":[8,8], "91":[10,10], "92":[10,10], "880":[10,10],
  "94":[9,9], "960":[7,7], "977":[10,10], "975":[8,8], "93":[9,9],
  "66":[9,9], "84":[9,10], "856":[9,9], "855":[8,9], "95":[9,10],
  "60":[9,10], "65":[8,8], "62":[9,12], "63":[10,10], "673":[7,7],
  "998":[9,9], "996":[9,9], "992":[9,9], "993":[8,8],
  // Oceania
  "61":[9,9], "64":[8,9], "679":[7,7], "675":[8,8],
};

function validateE164(phone: string): string | null {
  if (!phone || typeof phone !== "string") return "Invalid phone number.";
  if (!phone.startsWith("+")) return "Invalid phone number.";
  const digits = phone.slice(1).replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return "Invalid phone number.";
  // Longest-first dial code match (4 down to 1) so +254 resolves before +2
  for (let len = 4; len >= 1; len--) {
    const candidate = digits.slice(0, len);
    if (DIAL_DIGIT_COUNTS[candidate]) {
      const [min, max] = DIAL_DIGIT_COUNTS[candidate];
      const body = digits.slice(len);
      return (body.length < min || body.length > max) ? "Invalid phone number." : null;
    }
  }
  // No dial code matched — permissive fallback
  return digits.length < 7 ? "Invalid phone number." : null;
}

// ── Email validation ──────────────────────────────────────────────────────
// Single-line address only. Catches typos like missing @, missing TLD, spaces,
// trailing dots, doubled @, and other obvious garbage. NOT a deliverability
// check — that's only possible by sending mail (eTicket bounce is the
// downstream signal).
function validateEmail(email: string): string | null {
  if (!email || typeof email !== "string") return "Invalid email address.";
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return "Invalid email address.";
  // RFC-flavoured but practical: local-part@domain.tld, no spaces, single @
  const re = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
  if (!re.test(trimmed)) return "Invalid email address.";
  // Defensive: no consecutive dots, no leading/trailing dot in local-part
  const [local, domain] = trimmed.split("@");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "Invalid email address.";
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return "Invalid email address.";
  return null;
}

// Verify a Cloudflare Turnstile token by calling their siteverify endpoint.
// Returns true (allow) when no secret is configured — this is intentional: lets
// the function ship before the Turnstile site is registered at Cloudflare and
// the secret is set. Once TURNSTILE_SECRET is set in Supabase secrets,
// verification becomes enforced (returns true only if Cloudflare confirms).
async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) {
    // Fail-open: not configured yet
    return true;
  }
  if (!token) {
    return false;
  }
  const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (!data.success) {
      console.warn("Turnstile verification failed:", data["error-codes"]);
    }
    return !!data.success;
  } catch (e) {
    console.error("Turnstile siteverify network error:", e);
    return false; // fail-closed on network error when secret IS configured
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

async function getPesapalToken(): Promise<string> {
  const res = await fetch(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      consumer_key: PESAPAL_CONSUMER_KEY,
      consumer_secret: PESAPAL_CONSUMER_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`Pesapal auth failed: ${JSON.stringify(data)}`);
  return data.token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // GUARD: refuse if DUFFEL_MODE and DUFFEL_API_KEY disagree.
  const guardBlock = await checkDuffelModeKeyMismatch(alertFounder, "create-payment");
  if (guardBlock) return guardBlock;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Resolve user_id from request JWT (or null for guest checkout) ──────
  // Frontend sends the user's session JWT in Authorization when signed in,
  // or the anon key when not. supabase.auth.getUser(jwt) returns null for
  // the anon key — that's our signal it's a guest booking. user_id is then
  // stashed on pending_bookings so the webhook can copy it to bookings,
  // which is what My Trips filters on.
  let userId: string | null = null;
  const incomingAuth = req.headers.get("Authorization") || "";
  if (incomingAuth.startsWith("Bearer ")) {
    const userJwt = incomingAuth.slice(7);
    if (userJwt && userJwt !== SERVICE_ROLE_KEY) {
      try {
        const { data: { user } } = await supabase.auth.getUser(userJwt);
        if (user) userId = user.id;
      } catch (_) { /* guest checkout — leave userId null */ }
    }
  }

  try {
    const { offer_id, passengers, contact, seats, baggages, turnstile_token } = await req.json();

    // 1. Validate
    if (!offer_id || !passengers?.length || !contact?.email) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1a. Validate email format. Blocks obvious typos (missing @, no TLD, etc)
    // BEFORE Pesapal charges, so the customer can correct without losing money.
    const emailErr = validateEmail(contact.email);
    if (emailErr) {
      return new Response(JSON.stringify({ error: emailErr }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1b. Validate E.164 phone. Blocks bad digit counts (Victoria too short,
    // Tina too long) BEFORE Pesapal charges. Two confirmed PAID_NO_TICKET
    // refunds came from this exact bug — see TumaFly_Handoff_NextChat_8.md.
    const phoneErr = validateE164(contact.phone_number || "");
    if (phoneErr) {
      return new Response(JSON.stringify({ error: phoneErr }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1c. Bot protection (Cloudflare Turnstile). No-op when TURNSTILE_SECRET
    // isn't set, so this is safe to deploy before the Turnstile site is registered.
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

    // 2. Re-fetch offer to confirm validity & current price. We also request
    // `available_services` here so the baggage validation block (below) can
    // re-cost selected baggage without a second offer round-trip.
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

    // 3. Price calculation
    const baseAmountKES = await toKES(
      parseFloat(offer.total_amount),
      offer.total_currency
    );

    // 3a. Validate seat selections — re-fetch the seat map and verify each
    // selected service_id is still available, matches the segment, and re-cost
    // it at Duffel's current rate (frontend prices can be stale).
    // We tolerate the frontend not sending `seats` at all (optional feature).
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
          error: "Seat selection no longer available. Please reselect seats.",
        }), {
          status: 409,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // Build a flat lookup: service_id → { segment_id, total_amount, total_currency }
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
          // In production we fail-closed: Duffel would reject the order at booking
          // time anyway, and rejecting now means the customer hasn't paid yet.
          // In sandbox we soft-skip because Duffel's test mode often returns seat
          // services on the seat-map endpoint that aren't valid at /air/orders.
          if (DUFFEL_MODE === "sandbox") {
            console.warn("Seat service not re-found in re-validation (sandbox soft-skip):", s.service_id, s.designator);
            continue;
          }
          return new Response(JSON.stringify({
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

    // 3b. Validate baggage selections — mirror the seat pattern. Each
    // frontend submission is { passenger_index, service_id, quantity }; we
    // re-cost from authoritative Duffel data, bound quantity by Duffel's
    // maximum_quantity, and store on contact.baggages (no schema change).
    // Sandbox soft-skip if the service is missing — Duffel test mode often
    // omits baggage services from /air/orders even when they appear on the
    // offer endpoint.
    type ValidatedBaggage = {
      passenger_index: number;
      service_id: string;
      quantity: number;
      cost_kes: number;        // per-unit cost in KES
      total_kes: number;       // cost_kes * quantity
      original_amount: string; // per-unit Duffel amount
      original_currency: string;
    };
    let validatedBaggages: ValidatedBaggage[] = [];
    let baggageTotalKES = 0;
    if (Array.isArray(baggages) && baggages.length > 0) {
      // Build a service_id → { amount, currency, max_quantity } lookup from
      // the offer's available_services we fetched in step 2.
      const allServices: any[] = Array.isArray(offer.available_services)
        ? offer.available_services
        : [];
      const baggageLookup: Record<string, {
        amount: string;
        currency: string;
        max_quantity: number;
        passenger_ids: string[];
      }> = {};
      for (const svc of allServices) {
        if (svc?.type !== "baggage") continue;
        const maxQ = Number(svc.maximum_quantity ?? svc.metadata?.maximum_quantity ?? 1) || 1;
        baggageLookup[svc.id] = {
          amount: svc.total_amount,
          currency: svc.total_currency,
          max_quantity: Math.max(1, Math.min(maxQ, 10)),
          passenger_ids: Array.isArray(svc.passenger_ids) ? svc.passenger_ids : [],
        };
      }

      for (const b of baggages) {
        if (!b?.service_id) continue;
        const qty = Number(b.quantity) || 0;
        if (qty <= 0) continue;

        const svc = baggageLookup[b.service_id];
        if (!svc) {
          if (DUFFEL_MODE === "sandbox") {
            console.warn("Baggage service not re-found in re-validation (sandbox soft-skip):", b.service_id);
            continue;
          }
          return new Response(JSON.stringify({
            error: "A baggage selection is no longer available. Please reselect.",
          }), {
            status: 409,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        // Bound quantity by Duffel's maximum_quantity (defensive — frontend
        // already does this, but we trust nothing from the wire).
        const boundedQty = Math.min(qty, svc.max_quantity);
        if (boundedQty !== qty) {
          console.warn("Baggage quantity capped to Duffel max:", b.service_id, qty, "→", boundedQty);
        }

        // Validate the passenger_index has a corresponding Duffel passenger_id
        // that this service is actually offered for.
        const duffelPaxId = offer.passengers?.[b.passenger_index]?.id;
        if (duffelPaxId && svc.passenger_ids.length > 0 && !svc.passenger_ids.includes(duffelPaxId)) {
          if (DUFFEL_MODE === "sandbox") {
            console.warn("Baggage service not offered for this passenger (sandbox soft-skip):", b.service_id, duffelPaxId);
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
          // Bag metadata used by the eTicket email template. Sandbox sometimes
          // omits these — null-safe rendering is on the email side.
          bag_type: svc.metadata?.type || "checked",
          weight_kg: svc.metadata?.maximum_weight_kg ?? null,
        });
      }
    }

    // Roll seat costs into base — they're part of the airline-side cost for fee
    // and tax purposes (Pesapal gross-up applies on the full subtotal).
    const baseWithSeatsKES = baseAmountKES + seatsTotalKES;
    const subtotal = baseWithSeatsKES + baggageTotalKES + TUMAFLY_SERVICE_FEE_KES;
    // Gross-up: Pesapal charges rate on the total they receive, not on our subtotal.
    // So processingFee = subtotal * rate / (1 - rate) to ensure we net the full subtotal.
    const processingFeeKES = Math.ceil(subtotal * PESAPAL_FEE_RATE / (1 - PESAPAL_FEE_RATE));
    const totalKES = subtotal + processingFeeKES;

    // 4. Insert pending_booking BEFORE Pesapal call (so webhook can always find it)
    const merchantRef = `TF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Stash seat + baggage selections on the contact JSON (no schema change).
    // The webhook reads contact.seats and contact.baggages when building the
    // Duffel order's services array.
    const contactWithSeats = { ...contact, seats: validatedSeats, baggages: validatedBaggages };

    const { data: pending, error: insertErr } = await supabase
      .from("pending_bookings")
      .insert({
        user_id: userId,                  // null for guests; uid for signed-in users
        pesapal_order_id: merchantRef,
        duffel_offer_id: offer_id,
        passengers,
        contact: contactWithSeats,
        // base_amount_kes includes flight + seats + baggage (everything that
        // flows to Duffel / the airline as services). Keeps the webhook's
        // total-validation math straightforward.
        base_amount_kes: baseWithSeatsKES + baggageTotalKES,
        service_fee_kes: TUMAFLY_SERVICE_FEE_KES,
        processing_fee_kes: processingFeeKES,
        total_kes: totalKES,
        payment_method: "pending", // set by webhook after Pesapal confirms
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

    // 5. Create Pesapal order
    const token = await getPesapalToken();
    const [firstName, ...rest] = (passengers[0].given_name || "Customer").split(" ");
    const lastName = passengers[0].family_name || rest.join(" ") || "User";

    const submitRes = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        id: merchantRef,
        currency: "KES",
        amount: totalKES,
        description: `TumaFly flight ${offer.slices[0].origin.iata_code}-${offer.slices[0].destination.iata_code}`,
        callback_url: `${FRONTEND_URL}/?ref=${merchantRef}`,
        notification_id: PESAPAL_IPN_ID,
        billing_address: {
          email_address: contact.email,
          phone_number: contact.phone_number || "",
          first_name: firstName,
          last_name: lastName,
        },
      }),
    });

    const submitData = await submitRes.json();
    if (!submitData.redirect_url) {
      await supabase
        .from("pending_bookings")
        .update({ status: "failed_to_create" })
        .eq("id", pending.id);
      throw new Error(`Pesapal order failed: ${JSON.stringify(submitData)}`);
    }

    // 6. Save Pesapal tracking ID back to our record
    await supabase
      .from("pending_bookings")
      .update({ pesapal_tracking_id: submitData.order_tracking_id })
      .eq("id", pending.id);

    return new Response(JSON.stringify({
      success: true,
      redirect_url: submitData.redirect_url,
      tracking_id: submitData.order_tracking_id,
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
    console.error("create-payment error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});