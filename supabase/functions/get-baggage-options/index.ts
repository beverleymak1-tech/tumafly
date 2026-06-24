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

async function alertFounder(level: string, code: string, detail: string) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/alert-founder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ level, code, detail }),
    });
  } catch (_) { /* swallow — alerts must never block the response */ }
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
  cost_kes: number | null;   // null when not derivable; frontend converts
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
      await alertFounder('CRITICAL', 'DUFFEL_MODE_KEY_MISMATCH',
        `[get-baggage-options] ${MODE_KEY_REASON}`);
    }
    return new Response(
      JSON.stringify({ error: 'Service temporarily unavailable. Please try again shortly.' }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await req.json();
    const offer_id: string | undefined = body?.offer_id;
    // Optional FX hint from frontend's rateInfo so the EF can populate cost_kes
    // when the offer is priced in USD. Trusted for display only; create-payment
    // re-validates from authoritative Duffel data.
    const kes_to_usd: number | undefined = body?.kes_to_usd;

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

      // Derive cost_kes when possible:
      //   - If service is already in KES, pass through.
      //   - If service is in USD and we have a kes_to_usd hint, convert.
      //   - Otherwise null; frontend converts on display via formatKes.
      let cost_kes: number | null = null;
      if (currency === 'KES') {
        cost_kes = amountNum;
      } else if (currency === 'USD' && kes_to_usd && kes_to_usd > 0) {
        cost_kes = amountNum / kes_to_usd;
      }

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

    return new Response(
      JSON.stringify({
        baggages_by_passenger: grouped,
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