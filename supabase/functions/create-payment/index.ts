import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const PESAPAL_BASE_URL = Deno.env.get("PESAPAL_BASE_URL")!;
const PESAPAL_CONSUMER_KEY = Deno.env.get("PESAPAL_CONSUMER_KEY")!;
const PESAPAL_CONSUMER_SECRET = Deno.env.get("PESAPAL_CONSUMER_SECRET")!;
const PESAPAL_IPN_ID = Deno.env.get("PESAPAL_IPN_ID")!;
const FRONTEND_URL = Deno.env.get("FRONTEND_URL")!;

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

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

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

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { offer_id, passengers, contact } = await req.json();

    // 1. Validate
    if (!offer_id || !passengers?.length || !contact?.email) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 2. Re-fetch offer to confirm validity & current price
    const offerRes = await fetch(`${DUFFEL_BASE_URL}/air/offers/${offer_id}`, {
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
    const subtotal = baseAmountKES + TUMAFLY_SERVICE_FEE_KES;
    // Gross-up: Pesapal charges rate on the total they receive, not on our subtotal.
    // So processingFee = subtotal * rate / (1 - rate) to ensure we net the full subtotal.
    const processingFeeKES = Math.ceil(subtotal * PESAPAL_FEE_RATE / (1 - PESAPAL_FEE_RATE));
    const totalKES = subtotal + processingFeeKES;

    // 4. Insert pending_booking BEFORE Pesapal call (so webhook can always find it)
    const merchantRef = `TF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { data: pending, error: insertErr } = await supabase
      .from("pending_bookings")
      .insert({
        pesapal_order_id: merchantRef,
        duffel_offer_id: offer_id,
        passengers,
        contact,
        base_amount_kes: baseAmountKES,
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
        callback_url: `${FRONTEND_URL}/payment-complete?ref=${merchantRef}`,
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