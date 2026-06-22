// get-seat-maps
//
// Fetches a Duffel seat map for a given offer_id and returns a normalised shape
// the frontend can render without knowing Duffel internals.
//
// Duffel's seat-map response is per-segment, with each segment containing one or
// more cabins (front/main, sometimes split by class). Each cabin has rows (each
// with a "row number" and columns), and each row has elements (seats, exit rows,
// galleys, etc). Seats themselves have IDs and "available_services" which carry
// the seat price.
//
// We flatten to:
//   {
//     slices: [
//       {
//         slice_index: 0,
//         origin: "NBO", destination: "JNB",
//         segments: [
//           {
//             segment_id: "seg_xyz",
//             flight_number: "KQ766",
//             origin: "NBO", destination: "JNB",
//             aircraft_name: "Boeing 737-800",
//             cabins: [
//               {
//                 cabin_class: "economy",
//                 wings: { first_row_index: 12, last_row_index: 18 }, // for visual cue
//                 rows: [
//                   {
//                     row_number: "1",
//                     seats: [
//                       { id: "...", designator: "1A", available: true, cost_kes: 1200, cost_usd: 9.2, type: "standard", features: ["window"] },
//                       ...
//                       { type: "aisle" }, // non-seat slots in row order
//                       { type: "empty" },
//                     ]
//                   }
//                 ]
//               }
//             ]
//           }
//         ]
//       }
//     ]
//   }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

// Lightweight FX — single rate lookup per request. Seat prices are usually small
// so a small rounding spread is fine; we don't need the cache machinery from
// search-flights.
async function getRateToKES(): Promise<(amt: number, cur: string) => number> {
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = await res.json();
    const rates = data.rates || {};
    const kesPerUsd = rates.KES;
    if (!kesPerUsd) throw new Error("No KES rate");
    return (amt, cur) => {
      if (cur === "KES") return Math.round(amt);
      const rate = rates[cur];
      if (!rate) return Math.round(amt * (FALLBACK_RATES[cur] ?? 130));
      // 1 cur = (1/rate) USD = (kesPerUsd / rate) KES
      return Math.round(amt * (kesPerUsd / rate));
    };
  } catch {
    return (amt, cur) =>
      cur === "KES" ? Math.round(amt) : Math.round(amt * (FALLBACK_RATES[cur] ?? 130));
  }
}

async function getRateToUSD(): Promise<(amt: number, cur: string) => number> {
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = await res.json();
    const rates = data.rates || {};
    return (amt, cur) => {
      if (cur === "USD") return Math.round(amt * 100) / 100;
      const rate = rates[cur];
      if (!rate) return Math.round(amt / (FALLBACK_RATES[cur] ?? 130) * 130 * 100) / 100;
      return Math.round((amt / rate) * 100) / 100;
    };
  } catch {
    return (amt, cur) =>
      cur === "USD" ? amt : Math.round((amt / (FALLBACK_RATES[cur] ?? 130) * 130) * 100) / 100;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { offer_id } = await req.json();
    if (!offer_id) {
      return new Response(JSON.stringify({ error: "Missing offer_id" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    // 1. Fetch seat maps for this offer
    const smRes = await fetch(`${DUFFEL_BASE_URL}/air/seat_maps?offer_id=${offer_id}`, {
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
      },
    });
    const smData = await smRes.json();

    if (!smRes.ok) {
      // Many airlines don't expose seat maps via Duffel — that's expected.
      // Return a clean "unavailable" signal rather than a 5xx so the frontend can
      // gracefully show "seats assigned at check-in".
      return new Response(JSON.stringify({
        available: false,
        reason: smData.errors?.[0]?.message || "Seat maps not available for this offer",
        slices: [],
      }), { headers: CORS_HEADERS });
    }

    const seatMaps: any[] = smData.data || [];
    if (!seatMaps.length) {
      return new Response(JSON.stringify({
        available: false,
        reason: "Airline does not provide seat selection for this fare",
        slices: [],
      }), { headers: CORS_HEADERS });
    }

    // 2. Also fetch the offer so we know slice/segment ordering and labels.
    const offerRes = await fetch(`${DUFFEL_BASE_URL}/air/offers/${offer_id}`, {
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
      },
    });
    const offerData = await offerRes.json();
    if (!offerRes.ok) {
      return new Response(JSON.stringify({ error: "Offer no longer available" }), {
        status: 410,
        headers: CORS_HEADERS,
      });
    }
    const offer = offerData.data;

    const [toKES, toUSD] = await Promise.all([getRateToKES(), getRateToUSD()]);

    // 3. Index seat maps by segment_id for easy lookup
    const seatMapBySegment: Record<string, any> = {};
    for (const sm of seatMaps) {
      seatMapBySegment[sm.segment_id] = sm;
    }

    // 4. Walk the offer's slices/segments and project seat maps in offer order
    const slices = offer.slices.map((slice: any, sliceIdx: number) => ({
      slice_index: sliceIdx,
      origin: slice.origin.iata_code,
      destination: slice.destination.iata_code,
      segments: slice.segments.map((seg: any) => {
        const sm = seatMapBySegment[seg.id];
        if (!sm) {
          // No seat map for this segment (mixed-carrier offer where only some
          // legs expose seat selection). Frontend will display "Assigned at check-in".
          return {
            segment_id: seg.id,
            flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
            origin: seg.origin.iata_code,
            destination: seg.destination.iata_code,
            aircraft_name: seg.aircraft?.name || null,
            cabins: [],
            available: false,
          };
        }

        return {
          segment_id: seg.id,
          flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
          origin: seg.origin.iata_code,
          destination: seg.destination.iata_code,
          aircraft_name: seg.aircraft?.name || null,
          available: true,
          cabins: (sm.cabins || []).map((cabin: any) => {
            return {
              cabin_class: cabin.cabin_class,
              deck: cabin.deck ?? 0,
              wings: cabin.wings || null, // { first_row_index, last_row_index }
              // Row aisles is the indices BEFORE which an aisle sits. We rebuild
              // each row's column layout from `aisles` + `rows[i].sections` so
              // the frontend gets a flat ordered array of { type, ... }.
              aisles: cabin.aisles || [],
              rows: (cabin.rows || []).map((row: any) => {
                // A row has 1+ sections; each section is a contiguous block of
                // seats divided by aisle gaps. We just concat all section
                // elements in order and insert aisle markers between sections.
                const elements: any[] = [];
                (row.sections || []).forEach((section: any, sIdx: number) => {
                  if (sIdx > 0) elements.push({ type: "aisle" });
                  (section.elements || []).forEach((el: any) => {
                    if (el.type !== "seat") {
                      // Includes "exit_row", "galley", "lavatory", "bassinet", "empty", etc.
                      elements.push({ type: el.type });
                      return;
                    }
                    // It's a seat — extract price from the available_services entry
                    // (Duffel structures seat costs as services attached to the seat).
                    const svc = (el.available_services || [])[0];
                    let costKes = 0, costUsd = 0;
                    if (svc) {
                      const amt = parseFloat(svc.total_amount);
                      const cur = svc.total_currency;
                      costKes = toKES(amt, cur);
                      costUsd = toUSD(amt, cur);
                    }
                    elements.push({
                      type: "seat",
                      // Duffel seat IDs: the SERVICE id (svc.id) is what we send back
                      // to /air/orders to actually book the seat — NOT the seat element id.
                      service_id: svc?.id || null,
                      designator: el.designator,
                      available: !el.disclosures?.length && !!svc,
                      // Surface seat metadata for the frontend to highlight nice ones
                      features: extractSeatFeatures(el),
                      cost_kes: costKes,
                      cost_usd: costUsd,
                      currency_original: svc?.total_currency || null,
                      amount_original: svc?.total_amount ? parseFloat(svc.total_amount) : 0,
                    });
                  });
                });
                return {
                  row_number: row.sections?.[0]?.elements?.find((e: any) => e.type === "seat")?.designator?.replace(/\D/g, "") || null,
                  elements,
                };
              }),
            };
          }),
        };
      }),
    }));

    return new Response(JSON.stringify({
      available: true,
      slices,
    }), { headers: CORS_HEADERS });
  } catch (err) {
    console.error("get-seat-maps error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
});

// Extracts seat features (window/aisle/exit/extra legroom) from a Duffel seat element.
function extractSeatFeatures(el: any): string[] {
  const features: string[] = [];
  // Duffel exposes some metadata in element.disclosures (free-text) and element.designator (column letter)
  const designator = el.designator || "";
  const col = designator.slice(-1);
  // Window cols are A and the highest letter (varies by aircraft) — we approximate
  // with A and K (737/A320/777). Frontend doesn't show these as labels, just for filtering.
  if (col === "A") features.push("window");
  // Other features must come from disclosures since Duffel doesn't return strict flags.
  for (const d of el.disclosures || []) {
    const ld = String(d).toLowerCase();
    if (ld.includes("extra legroom") || ld.includes("extra-legroom")) features.push("extra_legroom");
    if (ld.includes("exit row") || ld.includes("exit-row")) features.push("exit_row");
    if (ld.includes("bulkhead")) features.push("bulkhead");
  }
  return features;
}
