// supabase/functions/get-baggage-options/index.ts
//
// Returns Duffel baggage services for a given offer, grouped by passenger.
// Parallel architecture to get-seat-maps:
//   - Same DUFFEL_MODE / DUFFEL_API_KEY mismatch guard pattern as
//     create-payment, pesapal-webhook, mpesa-callback.
//   - Soft-skip in sandbox when no baggage services exposed.
//   - Returns normalised options per-passenger, sorted by price ascending.
//
// Response shape:
// {
//   baggages_by_passenger: {
//     "pas_xxx": [{ service_id, bag_type, weight_kg, weight_lbs,
//                   cost_amount, cost_currency, cost_kes }, ...],
//     "pas_yyy": [...]
//   },
//   passengers: [{ id }],
//   offer_currency: "USD",
//   mode: "sandbox" | "production"
// }
//
// cost_kes is populated when convertible (currency is KES, or we can derive
// USD→KES from offer pricing); otherwise null and frontend converts via its
// own rateInfo. Authoritative re-validation happens in create-payment.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

const DUFFEL_API_KEY = Deno.env.get('DUFFEL_API_KEY') || '';
const DUFFEL_MODE = (Deno.env.get('DUFFEL_MODE') || '').toLowerCase();
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Mode/key mismatch guard ────────────────────────────────────────────────
// Fires once at cold start if DUFFEL_MODE doesn't match the key prefix.
// All requests refused with 503 + CRITICAL alert. Catches the launch-day
// "left mode as sandbox after key swap" disaster.
let MODE_KEY_OK = true;
let MODE_KEY_REASON = '';
const isTestKey = DUFFEL_API_KEY.startsWith('duffel_test_');
const isLiveKey = DUFFEL_API_KEY.startsWith('duffel_live_');
if (!DUFFEL_API_KEY) {
  MODE_KEY_OK = false;
  MODE_KEY_REASON = 'DUFFEL_API_KEY not set';
} else if (DUFFEL_MODE === 'sandbox' && !isTestKey) {
  MODE_KEY_OK = false;
  MODE_KEY_REASON = 'DUFFEL_MODE=sandbox but DUFFEL_API_KEY is not a test key';
} else if (DUFFEL_MODE === 'production' && !isLiveKey) {
  MODE_KEY_OK = false;
  MODE_KEY_REASON = 'DUFFEL_MODE=production but DUFFEL_API_KEY is not a live key';
} else if (DUFFEL_MODE !== 'sandbox' && DUFFEL_MODE !== 'production') {
  MODE_KEY_OK = false;
  MODE_KEY_REASON = `DUFFEL_MODE has unexpected value: "${DUFFEL_MODE}"`;
}
let modeKeyAlertFired = false;

// Standardized two-arg shape to match all other EFs (Session 28b #7b-ii-alerts).
// Prior three-arg (level, code, detail) also sent { level, code, detail } as the
// body, but alert-founder reads { alert_type, context } — so this helper was
// silently dropping every fire. Two bugs stacked (wrong signature + wrong body
// shape), both closed here.
async function alertFounder(alertType: string, context: Record<string, unknown>) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/alert-founder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ alert_type: alertType, context }),
    });
  } catch (_) { /* swallow — alerts must never block the response */ }
}

// ── FX: convert any Duffel currency to KES ─────────────────────────────────
// Mirrors the toKES helper in create-payment so prices the user sees on the
// baggage modal match what create-payment will re-cost server-side at booking.
// Fetches live rates lazily, caches per-invocation, falls back to a static
// table on network failure.
const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36, ZAR: 7, NGN: 0.08,
};
const liveRateCache: Record<string, number> = {};

async function toKES(amount: number, fromCurrency: string): Promise<number> {
  if (!fromCurrency || fromCurrency === 'KES') return Math.round(amount);
  const ccy = fromCurrency.toUpperCase();
  if (liveRateCache[ccy] != null) {
    return Math.round(amount * liveRateCache[ccy]);
  }
  try {
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${ccy}`);
    const data = await res.json();
    const rate = data?.rates?.KES;
    if (rate && rate > 0) {
      liveRateCache[ccy] = rate;
      return Math.round(amount * rate);
    }
  } catch (_) { /* fall through to static */ }
  const fallback = FALLBACK_RATES[ccy] || 130;
  liveRateCache[ccy] = fallback;
  return Math.round(amount * fallback);
}

// ── Types ──────────────────────────────────────────────────────────────────
interface BaggageOption {
  service_id: string;
  passenger_id: string;
  bag_type: string;          // 'checked' | 'carry_on' | other Duffel value
  weight_kg: number | null;
  weight_lbs: number | null;
  cost_amount: string;       // raw Duffel amount in offer currency
  cost_currency: string;
  cost_kes: number;          // always populated (server-side FX via toKES)
  max_quantity: number;      // upper bound for the stepper UI
}

// ── Handler ────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  // Mode/key mismatch guard — refuse + one-shot alert per cold start
  if (!MODE_KEY_OK) {
    if (!modeKeyAlertFired) {
      modeKeyAlertFired = true;
      await alertFounder("DUFFEL_MODE_KEY_MISMATCH", {
              source: "get-baggage-options",
              reason: MODE_KEY_REASON,
            });
    }
    return new Response(
      JSON.stringify({ error: 'Service temporarily unavailable. Please try again shortly.' }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await req.json();
    const offer_id: string | undefined = body?.offer_id;

    if (!offer_id || typeof offer_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'offer_id required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch offer with services from Duffel
    const url = `https://api.duffel.com/air/offers/${encodeURIComponent(offer_id)}?return_available_services=true`;
    const dfRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${DUFFEL_API_KEY}`,
        'Duffel-Version': 'v2',
        'Accept': 'application/json',
      },
    });

    if (!dfRes.ok) {
      const txt = await dfRes.text();
      console.error('[get-baggage-options] Duffel fetch failed', dfRes.status, txt.slice(0, 500));
      // 200 with empty result so the frontend can render the static fallback
      // ("If you're travelling with bags...") rather than blocking the booking flow.
      return new Response(
        JSON.stringify({ baggages_by_passenger: {}, passengers: [], mode: DUFFEL_MODE }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const json = await dfRes.json();
    const offer = json?.data;
    if (!offer) {
      return new Response(
        JSON.stringify({ baggages_by_passenger: {}, passengers: [], mode: DUFFEL_MODE }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const offerCurrency = (offer.total_currency || 'USD').toUpperCase();
    const services: any[] = Array.isArray(offer.available_services)
      ? offer.available_services
      : [];
    const baggageServices = services.filter((s) => s?.type === 'baggage');

    // Soft-skip in sandbox when no baggage services come back — Duffel test
    // mode often omits them. Frontend keeps showing the static fallback card.
    if (DUFFEL_MODE === 'sandbox' && baggageServices.length === 0) {
      return new Response(
        JSON.stringify({
          baggages_by_passenger: {},
          passengers: (offer.passengers || []).map((p: any) => ({ id: p.id })),
          offer_currency: offerCurrency,
          mode: 'sandbox_no_services',
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Group by passenger_id. Duffel baggage service shape:
    //   { id, type: 'baggage', total_amount, total_currency,
    //     passenger_ids: ['pas_xxx', ...],
    //     metadata: { type: 'checked'|'carry_on', maximum_weight_kg, ... } }
    const grouped: Record<string, BaggageOption[]> = {};
    for (const svc of baggageServices) {
      const passengerIds: string[] = Array.isArray(svc.passenger_ids) ? svc.passenger_ids : [];
      if (!passengerIds.length) continue;

      const meta = svc.metadata || {};
      const weightKg = typeof meta.maximum_weight_kg === 'number'
        ? meta.maximum_weight_kg
        : (meta.maximum_weight_kg ? parseFloat(meta.maximum_weight_kg) : null);
      const weightLbs = weightKg != null ? Math.round(weightKg * 2.20462) : null;
      const bagType = String(meta.type || 'checked');
      const amount = String(svc.total_amount || '0');
      const currency = String(svc.total_currency || offerCurrency).toUpperCase();
      const amountNum = parseFloat(amount) || 0;
      // Duffel sometimes returns maximum_quantity on the service itself, sometimes
      // on metadata, sometimes not at all. Default to 1 if missing — covers the
      // common "one service per quantity" pattern (e.g. svc_1bag, svc_2bags).
      const maxQ = Number(svc.maximum_quantity ?? meta.maximum_quantity ?? 1) || 1;

      // Derive cost_kes via authoritative server-side FX so the frontend
      // doesn't need a per-currency rate. Mirrors create-payment's toKES so
      // displayed prices match what gets charged. Live-rate fetched lazily
      // per currency (cached within this invocation); fallback table covers
      // network failure.
      const cost_kes = await toKES(amountNum, currency);

      for (const pid of passengerIds) {
        if (!grouped[pid]) grouped[pid] = [];
        grouped[pid].push({
          service_id: svc.id,
          passenger_id: pid,
          bag_type: bagType,
          weight_kg: weightKg,
          weight_lbs: weightLbs,
          cost_amount: amount,
          cost_currency: currency,
          cost_kes,
          max_quantity: Math.max(1, Math.min(maxQ, 10)),
        });
      }
    }

    // Sort each passenger's options by price ascending, then weight ascending
        for (const pid of Object.keys(grouped)) {
          grouped[pid].sort((a, b) => {
            const pa = parseFloat(a.cost_amount) || 0;
            const pb = parseFloat(b.cost_amount) || 0;
            if (pa !== pb) return pa - pb;
            return (a.weight_kg ?? 0) - (b.weight_kg ?? 0);
          });
        }

        // ── Fare-included baggage aggregation (Session 28f) ────────────────
        // Duffel exposes fare-included allowance at
        //   slices[].segments[].passengers[].baggages
        // as [{ type, quantity }]. Ancillary (paid) baggages never overlap
        // with these — per Duffel docs, ancillary baggages booked as services
        // do NOT appear in slices[].segments[].passengers[].baggages[]. Zero
        // risk of double-counting.
        //
        // Aggregation rule: MIN across segments per passenger per bag_type.
        // If any segment strips a bag type, the passenger effectively doesn't
        // have it end-to-end. Safe read for what's guaranteed to travel.
        //
        // Summary field: MIN across passengers WITH any non-zero bag total.
        // Filters out infants / fare-differentiated pax so their zero doesn't
        // drag the universal "per traveler" pill to zero. If every passenger
        // has zero allowance, summary is empty and frontend hides the panel.
        const freeBagsByPax: Record<string, Record<string, number>> = {};
        for (const slice of (Array.isArray(offer.slices) ? offer.slices : [])) {
          for (const seg of (Array.isArray(slice.segments) ? slice.segments : [])) {
            for (const paxOnSeg of (Array.isArray(seg.passengers) ? seg.passengers : [])) {
              const pid = paxOnSeg?.passenger_id;
              if (!pid) continue;
              const segCounts: Record<string, number> = {};
              for (const b of (Array.isArray(paxOnSeg.baggages) ? paxOnSeg.baggages : [])) {
                const t = String(b?.type || '').toLowerCase();
                if (!t) continue;
                segCounts[t] = (segCounts[t] || 0) + (Number(b.quantity) || 0);
              }
              if (!(pid in freeBagsByPax)) {
                freeBagsByPax[pid] = { ...segCounts };
              } else {
                const allTypes = new Set([
                  ...Object.keys(freeBagsByPax[pid]),
                  ...Object.keys(segCounts),
                ]);
                for (const t of allTypes) {
                  const cur = freeBagsByPax[pid][t] || 0;
                  const sg = segCounts[t] || 0;
                  freeBagsByPax[pid][t] = Math.min(cur, sg);
                }
              }
            }
          }
        }
        const paxWithAnyBag = Object.entries(freeBagsByPax)
          .filter(([, counts]) => Object.values(counts).some(q => q > 0));
        const freeBaggagesSummary: Record<string, number> = {};
        if (paxWithAnyBag.length > 0) {
          const allTypes = new Set<string>();
          paxWithAnyBag.forEach(([, counts]) =>
            Object.keys(counts).forEach(t => allTypes.add(t))
          );
          for (const t of allTypes) {
            const minAcrossPax = Math.min(
              ...paxWithAnyBag.map(([, c]) => c[t] || 0)
            );
            if (minAcrossPax > 0) freeBaggagesSummary[t] = minAcrossPax;
          }
        }

        return new Response(
              JSON.stringify({
                baggages_by_passenger: grouped,
                free_baggages_by_passenger: freeBagsByPax,
                free_baggages_summary: freeBaggagesSummary,
                passengers: (offer.passengers || []).map((p: any) => ({ id: p.id })),
                offer_currency: offerCurrency,
                mode: DUFFEL_MODE,
              }),
              { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          } catch (err: any) {
    console.error('[get-baggage-options] error', err?.message, err?.stack);
    return new Response(
      JSON.stringify({ error: 'Internal error fetching baggage options' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
});