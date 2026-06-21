import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY");
const DUFFEL_BASE_URL = "https://api.duffel.com";

const CABIN_CLASSES = ["economy", "premium_economy", "business", "first"] as const;
type CabinClass = typeof CABIN_CLASSES[number];

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

// ---------- FX ----------

let cachedRates: { date: string; usdPerKes: number; ratesFromX: Record<string, { kes: number; usd: number }> } | null = null;
let cachedRatesAt = 0;
const FX_CACHE_MS = 10 * 60 * 1000; // 10 minutes

async function getRates(): Promise<{ rateDate: string | null; isLive: boolean; toKES: (amt: number, cur: string) => number; toUSD: (amt: number, cur: string) => number }> {
  // Single FX call per search burst (was 1 per offer before — heavy waste at 4 cabins × N offers)
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
    // Anchor on USD; derive all conversions from there
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = await res.json();
    const date = data.date || new Date().toISOString().split("T")[0];
    const rates = data.rates || {};
    const kesPerUsd = rates.KES;
    if (!kesPerUsd) throw new Error("No KES rate in response");

    // Build a per-currency map: how many KES/USD per 1 unit of currency X
    const ratesFromX: Record<string, { kes: number; usd: number }> = {};
    for (const [cur, rate] of Object.entries(rates) as [string, number][]) {
      if (!rate || rate <= 0) continue;
      // 1 X = (1 / rate) USD = (kesPerUsd / rate) KES
      ratesFromX[cur] = { kes: kesPerUsd / rate, usd: 1 / rate };
    }
    ratesFromX["USD"] = { kes: kesPerUsd, usd: 1 };

    cachedRates = { date, usdPerKes: 1 / kesPerUsd, ratesFromX };
    cachedRatesAt = Date.now();

    return {
      rateDate: date,
      isLive: true,
      toKES: (amt, cur) => Math.round(amt * (ratesFromX[cur]?.kes ?? FALLBACK_RATES[cur] ?? 130)),
      toUSD: (amt, cur) => cur === "USD" ? amt : Math.round(amt * (ratesFromX[cur]?.usd ?? 1) * 100) / 100,
    };
  } catch {
    return {
      rateDate: null,
      isLive: false,
      toKES: (amt, cur) => Math.round(amt * (FALLBACK_RATES[cur] ?? 130)),
      toUSD: (amt, cur) => {
        if (cur === "USD") return amt;
        const kesFactor = FALLBACK_RATES[cur] ?? 130;
        // back into USD via fallback KES anchor of 130
        return Math.round(amt * (kesFactor / 130) * 100) / 100;
      },
    };
  }
}

// ---------- Helpers ----------

function layoverMinutes(arrival: string, departure: string): number {
  return Math.round((new Date(departure).getTime() - new Date(arrival).getTime()) / 60000);
}

function formatLayover(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

// Build a stable identity key for a flight across cabin classes.
// Same airline marketing flight numbers + same departure timestamps = same physical flight.
// We use the outbound slice + (if present) the return slice to identify a paired round-trip offer.
function offerIdentityKey(offer: any): string {
  return offer.slices.map((s: any) =>
    s.segments.map((seg: any) =>
      `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}@${seg.departing_at}`
    ).join("|")
  ).join(">");
}

// ---------- Duffel ----------

async function fetchOffersForCabin(
  slices: any[],
  passengers: number,
  cabin: CabinClass,
): Promise<{ offers: any[]; error: any | null }> {
  const body = {
    data: {
      slices,
      passengers: Array(passengers).fill({ type: "adult" }),
      cabin_class: cabin,
    },
  };
  try {
    const res = await fetch(`${DUFFEL_BASE_URL}/air/offer_requests?return_offers=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { offers: [], error: data };
    return { offers: data.data?.offers || [], error: null };
  } catch (err) {
    return { offers: [], error: { message: (err as Error).message } };
  }
}

// ---------- Main ----------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { origin, destination, date, return_date, passengers = 1 } = await req.json();

    const slices: any[] = [{ origin, destination, departure_date: date }];
    if (return_date) {
      slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    // Fan out across all cabin classes IN PARALLEL — bound by the slowest single Duffel call,
    // not the sum.
    const [eco, prem, biz, frst, fx] = await Promise.all([
      fetchOffersForCabin(slices, passengers, "economy"),
      fetchOffersForCabin(slices, passengers, "premium_economy"),
      fetchOffersForCabin(slices, passengers, "business"),
      fetchOffersForCabin(slices, passengers, "first"),
      getRates(),
    ]);

    // If economy failed entirely, that's a real error — bubble it up.
    // (Premium/Biz/First can legitimately be empty on routes where no carrier offers them.)
    if (eco.error && !eco.offers.length && !prem.offers.length && !biz.offers.length && !frst.offers.length) {
      return new Response(JSON.stringify({ error: eco.error }), {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    type Bucket = {
      identity: string;
      // We pick the economy offer as the "canonical" one for itinerary display when present;
      // else fall back to whichever cabin we got.
      canonical: any;
      cabins: Record<CabinClass, { offer_id: string; price_kes: number; price_usd: number } | null>;
    };
    const buckets = new Map<string, Bucket>();

    function ingest(offers: any[], cabin: CabinClass) {
      for (const o of offers) {
        const key = offerIdentityKey(o);
        const original = parseFloat(o.total_amount);
        const priceKES = fx.toKES(original, o.total_currency);
        const priceUSD = fx.toUSD(original, o.total_currency);

        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            identity: key,
            canonical: o,
            cabins: { economy: null, premium_economy: null, business: null, first: null },
          };
          buckets.set(key, bucket);
        }
        // Prefer the lowest-priced offer in each cabin (Duffel can return multiple
        // offers for the same physical flight at different fare classes).
        const existing = bucket.cabins[cabin];
        if (!existing || priceKES < existing.price_kes) {
          bucket.cabins[cabin] = { offer_id: o.id, price_kes: priceKES, price_usd: priceUSD };
        }
        // Promote canonical to the lowest-cabin offer we have, for stable schedule display
        // (economy schedules are usually the most representative)
        if (cabin === "economy") bucket.canonical = o;
      }
    }

    ingest(eco.offers, "economy");
    ingest(prem.offers, "premium_economy");
    ingest(biz.offers, "business");
    ingest(frst.offers, "first");

    // Now project each bucket into the frontend offer shape
    const offers = Array.from(buckets.values()).map((b) => {
      const o = b.canonical;
      return {
        // Use canonical (lowest-cabin) offer_id as the "id" for backward compat;
        // for booking, frontend will pick offer_id from the chosen cabin.
        id: o.id,
        flight_key: b.identity,
        rate_date: fx.rateDate,
        rate_is_live: fx.isLive,
        currency: "KES",
        currency_original: o.total_currency,
        airline: o.owner.name,
        airline_logo: o.owner.logo_symbol_url,

        // Per-cabin pricing (null = not offered for this flight)
        cabins: b.cabins,

        // For quick reference — the lowest price across all cabins
        // (the frontend can sort/display by this when no cabin is selected)
        lowest_price_kes: Math.min(...Object.values(b.cabins).filter(Boolean).map((c: any) => c.price_kes)),
        lowest_price_usd: Math.min(...Object.values(b.cabins).filter(Boolean).map((c: any) => c.price_usd)),

        // BACKWARD COMPAT for any frontend code that still expects price/price_usd at top level:
        // expose lowest cabin's prices here too.
        price: Math.min(...Object.values(b.cabins).filter(Boolean).map((c: any) => c.price_kes)),
        price_usd: Math.min(...Object.values(b.cabins).filter(Boolean).map((c: any) => c.price_usd)),

        slices: o.slices.map((slice: any) => {
          const segments = slice.segments.map((seg: any, idx: number) => {
            const segObj: any = {
              flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
              airline: seg.marketing_carrier.name,
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
              cabin_class: seg.passengers?.[0]?.cabin_class_marketing_name || "Economy",
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
    });

    // Sort by lowest available price ascending (frontend can re-sort)
    offers.sort((a, b) => a.lowest_price_kes - b.lowest_price_kes);

    return new Response(
      JSON.stringify({
        success: true,
        count: offers.length,
        offers,
        // Diagnostics — useful when one cabin's Duffel call fails so frontend can show why
        cabin_diagnostics: {
          economy: { ok: !eco.error, count: eco.offers.length },
          premium_economy: { ok: !prem.error, count: prem.offers.length },
          business: { ok: !biz.error, count: biz.offers.length },
          first: { ok: !frst.error, count: frst.offers.length },
        },
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
