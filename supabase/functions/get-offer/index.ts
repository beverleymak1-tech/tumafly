// Edge Function: get-offer
//
// Fetches a fresh copy of a single Duffel offer by ID and projects it into the
// same shape that search-flights returns for one bucket. Used by the booking
// page's refresh-restore path (step 3 of the #4 refresh-restore work): the
// URL carries `#booking?offer=off_xxx`, the frontend calls this EF, and uses
// the response to reconstruct selectedOutbound / selectedInbound and re-render
// the booking page identically to what the user saw before the refresh.
//
// Why a single-offer EF instead of re-running search-flights:
//   - Duffel offer IDs are stable for ~20 minutes; we can fetch them directly
//     via GET /air/offers/{id} which is cheaper than another offer_request.
//   - Re-running a search would give DIFFERENT offer IDs (Duffel generates
//     fresh ones per offer_request), breaking the URL contract — the frontend
//     would need to map the URL's offer ID to whatever new ID came back.
//   - Direct fetch lets us detect "this exact offer is gone" cleanly (Duffel
//     returns 404 / 410-equivalent), and surface that to the user with a
//     graceful "fare no longer available, please search again" message.
//
// Output shape mirrors what search-flights emits per bucket — same fields,
// same naming — so the frontend can pass the response directly into the
// existing rendering paths (renderPassengerForms, renderBookingSummary,
// computeTripInternational, etc.) without a special restore-only code path.
//
// Note: this EF only fetches a SINGLE cabin (whichever the Duffel offer
// belongs to). Unlike search-flights which fans out across all 4 cabins, here
// the user has already committed to a specific cabin — we only need to
// resurrect THAT one cabin's pricing. Returning a `cabins` object with only
// the matched cabin populated, and the rest null, matches the bucket shape
// while being honest about what we know.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY");
const DUFFEL_BASE_URL = "https://api.duffel.com";
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET") || "";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const CABIN_CLASSES = ["economy", "premium_economy", "business", "first"] as const;
type CabinClass = typeof CABIN_CLASSES[number];

// Map Duffel's offer-level cabin_class (lowercase snake_case) to our internal
// type. Duffel uses these exact strings, so this is mostly a type narrower.
function normaliseCabin(raw: string | null | undefined): CabinClass {
  const c = (raw || "economy").toLowerCase().replace(/[-\s]/g, "_");
  if ((CABIN_CLASSES as readonly string[]).includes(c)) return c as CabinClass;
  return "economy";
}

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

// Same Turnstile verification pattern as search-flights — fail-open when not
// configured, enforce once TURNSTILE_SECRET is set. Lets the EF ship cleanly.
async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;
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

// ---------- FX (same shape as search-flights, copy is intentional — keeps EFs
// independently deployable; small enough to live in two places without drift
// pain. If you update search-flights' FX logic, update this too.) ----------

let cachedRates: { date: string; usdPerKes: number; ratesFromX: Record<string, { kes: number; usd: number }> } | null = null;
let cachedRatesAt = 0;
const FX_CACHE_MS = 10 * 60 * 1000;

async function getRates(): Promise<{ rateDate: string | null; isLive: boolean; toKES: (amt: number, cur: string) => number; toUSD: (amt: number, cur: string) => number }> {
  if (cachedRates && Date.now() - cachedRatesAt < FX_CACHE_MS) {
    const r = cachedRates;
    return {
      rateDate: r.date,
      isLive: true,
      toKES: (amt, cur) => Math.round(amt * (r.ratesFromX[cur]?.kes ?? FALLBACK_RATES[cur] ?? 130)),
      toUSD: (amt, cur) => cur === "USD" ? amt : Math.round(amt * (r.ratesFromX[cur]?.usd ?? (1 / (FALLBACK_RATES[cur] ? FALLBACK_RATES[cur] / 130 : 1))) * 100) / 100,
    };
  }
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = await res.json();
    const date = data.date || new Date().toISOString().split("T")[0];
    const rates = data.rates || {};
    const kesPerUsd = rates.KES;
    if (!kesPerUsd) throw new Error("No KES rate in response");

    const ratesFromX: Record<string, { kes: number; usd: number }> = {};
    for (const [cur, rate] of Object.entries(rates)) {
      const r = rate as number;
      if (!r) continue;
      const usdPerX = 1 / r;
      const kesPerX = kesPerUsd / r;
      ratesFromX[cur] = { kes: kesPerX, usd: usdPerX };
    }
    ratesFromX["USD"] = { kes: kesPerUsd, usd: 1 };

    cachedRates = { date, usdPerKes: 1 / kesPerUsd, ratesFromX };
    cachedRatesAt = Date.now();
    return {
      rateDate: date,
      isLive: true,
      toKES: (amt, cur) => Math.round(amt * (ratesFromX[cur]?.kes ?? FALLBACK_RATES[cur] ?? 130)),
      toUSD: (amt, cur) => cur === "USD" ? amt : Math.round(amt * (ratesFromX[cur]?.usd ?? (1 / (FALLBACK_RATES[cur] ? FALLBACK_RATES[cur] / 130 : 1))) * 100) / 100,
    };
  } catch (e) {
    console.warn("[get-offer] FX fetch failed, using fallbacks:", (e as Error).message);
    return {
      rateDate: null,
      isLive: false,
      toKES: (amt, cur) => Math.round(amt * (FALLBACK_RATES[cur] ?? 130)),
      toUSD: (amt, cur) => cur === "USD" ? amt : Math.round(amt / (FALLBACK_RATES[cur] ? FALLBACK_RATES[cur] / 130 : 1) * 100) / 100,
    };
  }
}

function layoverMinutes(arrival: string, departure: string): number {
  return Math.round((new Date(departure).getTime() - new Date(arrival).getTime()) / 60000);
}

function formatLayover(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

// Stable per-flight identity key — same construction as search-flights so a
// refresh-restored offer carries the same flight_key as it would on a fresh
// search. Lets downstream lookups (e.g., the legacy `allOffers.find(o =>
// o.flight_key === ...)` pattern at line 9761) match if it's ever needed.
function offerIdentityKey(offer: any): string {
  return offer.slices.map((s: any) =>
    s.segments.map((seg: any) =>
      `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}@${seg.departing_at}`
    ).join("|")
  ).join(">");
}

// ---------- Main ----------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { offer_id, turnstile_token } = await req.json();
    if (!offer_id || typeof offer_id !== "string" || !/^off_[A-Za-z0-9]+$/.test(offer_id)) {
      return new Response(JSON.stringify({ error: "Invalid offer_id format." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || undefined;
    const passesTurnstile = await verifyTurnstileToken(turnstile_token || "", clientIp);
    if (!passesTurnstile) {
      return new Response(JSON.stringify({
        error: "Verification failed. Please refresh the page and try again.",
      }), {
        status: 403,
        headers: CORS_HEADERS,
      });
    }

    // Fetch the offer from Duffel. Duffel returns 404 if the ID was never
    // valid, or 200 with `data.expires_at` in the past if it's stale.
    let res: Response;
    try {
      res = await fetch(`${DUFFEL_BASE_URL}/air/offers/${offer_id}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Duffel-Version": "v2",
          Accept: "application/json",
        },
      });
    } catch (err) {
      // Network-level failure — distinguishable from offer-expired so the
      // frontend can show "Could not connect" rather than "fare expired".
      return new Response(JSON.stringify({
        error: { message: "Could not reach Duffel. Please check your network and try again." },
      }), { status: 502, headers: CORS_HEADERS });
    }

    const body = await res.json();
    if (!res.ok) {
      // Surface Duffel's 404 / 422 (offer-not-found / expired) as 410 Gone
      // so the frontend can pattern-match on status code to decide whether
      // to show the "fare no longer available" modal vs a generic error.
      // Anything else (auth, rate limit, 5xx) maps to a generic 502.
      const isGone = res.status === 404 || res.status === 422;
      return new Response(JSON.stringify({
        error: isGone
          ? "This fare is no longer available. Search again to see fresh prices."
          : "Could not fetch offer details. Please try again.",
        duffel_status: res.status,
        duffel_errors: body?.errors || null,
      }), {
        status: isGone ? 410 : 502,
        headers: CORS_HEADERS,
      });
    }

    const o = body?.data;
    if (!o || !o.id || !Array.isArray(o.slices) || !o.slices.length) {
      return new Response(JSON.stringify({
        error: "Malformed offer response from Duffel.",
      }), { status: 502, headers: CORS_HEADERS });
    }

    // Belt-and-suspenders expiry check. Duffel sometimes returns 200 with an
    // already-stale expires_at if the offer was JUST captured but not yet
    // garbage-collected on their side. Treat that the same as a hard 404.
    if (o.expires_at) {
      const expMs = new Date(o.expires_at).getTime();
      if (Number.isFinite(expMs) && expMs < Date.now()) {
        return new Response(JSON.stringify({
          error: "This fare just expired. Search again to see fresh prices.",
          duffel_status: 200,
          duffel_errors: null,
        }), { status: 410, headers: CORS_HEADERS });
      }
    }

    const fx = await getRates();

    const original = parseFloat(o.total_amount);
    const priceKES = fx.toKES(original, o.total_currency);
    const priceUSD = fx.toUSD(original, o.total_currency);

    const conditions = o.conditions ? {
      change_before_departure: o.conditions.change_before_departure || null,
      refund_before_departure: o.conditions.refund_before_departure || null,
    } : null;

    const firstPax = o.slices?.[0]?.segments?.[0]?.passengers?.[0];
    const included_baggages = Array.isArray(firstPax?.baggages)
      ? firstPax.baggages
          .filter((b: any) => b && b.type)
          .map((b: any) => ({ type: b.type, quantity: b.quantity ?? 1 }))
      : null;

    // Build the per-cabin pricing for the one cabin this offer belongs to.
    // Other cabins are null — at restore time the frontend already knows
    // which cabin the user selected (it's encoded in the URL implicitly via
    // the offer_id), so it doesn't need the alternatives.
    const cabin = normaliseCabin(o.cabin_class || firstPax?.cabin_class);
    const cabinsObj: Record<CabinClass, any> = {
      economy: null, premium_economy: null, business: null, first: null,
    };
    cabinsObj[cabin] = {
      offer_id: o.id,
      price_kes: priceKES,
      price_usd: priceUSD,
      conditions,
      included_baggages,
    };

    // Project into the same per-bucket output shape as search-flights, so the
    // frontend can drop the response directly into the `selectedOutbound.offer`
    // slot without any restore-specific transformation logic.
    const offer = {
      id: o.id,
      flight_key: offerIdentityKey(o),
      rate_date: fx.rateDate,
      rate_is_live: fx.isLive,
      currency: "KES",
      currency_original: o.total_currency,
      airline: o.owner?.name || null,
      airline_logo: o.owner?.logo_symbol_url || null,
      cabins: cabinsObj,
      lowest_price_kes: priceKES,
      lowest_price_usd: priceUSD,
      // Backward-compat top-level price (same fields search-flights surfaces).
      price: priceKES,
      price_usd: priceUSD,
      conditions,
      expires_at: o.expires_at || null,

      slices: o.slices.map((slice: any) => {
        const segments = slice.segments.map((seg: any, idx: number) => {
          const pax = seg.passengers?.[0];
          const am = pax?.cabin?.amenities;

          const wifi = am?.wifi && String(am.wifi.available).toLowerCase() === "true"
            ? { available: true, cost: am.wifi.cost || null }
            : null;
          const power = am?.power && String(am.power.available).toLowerCase() === "true"
            ? { available: true }
            : null;
          const seat = am?.seat && (am.seat.pitch || am.seat.legroom || am.seat.type)
            ? { type: am.seat.type || null, pitch: am.seat.pitch || null, legroom: am.seat.legroom || null }
            : null;

          const segObj: any = {
            flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
            airline: seg.marketing_carrier.name,
            operating_carrier: seg.operating_carrier?.name || null,
            aircraft: seg.aircraft?.name || null,
            origin: seg.origin.iata_code,
            origin_name: seg.origin.name,
            origin_city: seg.origin.city_name,
            origin_country: seg.origin.iata_country_code,
            destination: seg.destination.iata_code,
            destination_name: seg.destination.name,
            destination_city: seg.destination.city_name,
            destination_country: seg.destination.iata_country_code,
            departure: seg.departing_at,
            arrival: seg.arriving_at,
            duration: seg.duration,
            cabin_class: pax?.cabin_class_marketing_name || "Economy",
            amenities: { wifi, power, seat },
          };
          if (idx < slice.segments.length - 1) {
            const nextSeg = slice.segments[idx + 1];
            segObj.layover_minutes = layoverMinutes(seg.arriving_at, nextSeg.departing_at);
            segObj.layover_formatted = formatLayover(segObj.layover_minutes);
            segObj.layover_overnight = segObj.layover_minutes >= 360;
          }
          return segObj;
        });
        return {
          origin: slice.origin.iata_code,
          origin_name: slice.origin.name,
          origin_country: slice.origin.iata_country_code,
          destination: slice.destination.iata_code,
          destination_name: slice.destination.name,
          destination_country: slice.destination.iata_country_code,
          departure: slice.segments[0].departing_at,
          arrival: slice.segments[slice.segments.length - 1].arriving_at,
          duration: slice.duration,
          stops: slice.segments.length - 1,
          segments,
        };
      }),
    };

    // Passenger count from the Duffel offer's passengers array. We need this
    // on the frontend to set travelers.adults and passengerCount before
    // proceedToBooking renders the right number of passenger forms.
    const passengers_count = Array.isArray(o.passengers) ? o.passengers.length : 1;
    // Selected cabin (top-level) for convenience — the frontend already gets
    // it inside cabinsObj, but having it explicit avoids a "find the non-null
    // cabin key" loop on every restore.
    const selected_cabin = cabin;

    return new Response(
      JSON.stringify({
        success: true,
        offer,
        selected_cabin,
        passengers_count,
      }),
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
});