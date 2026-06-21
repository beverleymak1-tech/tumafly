import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

// Daraja config
const DARAJA_BASE_URL = Deno.env.get("DARAJA_BASE_URL")!;
const DARAJA_CONSUMER_KEY = Deno.env.get("DARAJA_CONSUMER_KEY")!;
const DARAJA_CONSUMER_SECRET = Deno.env.get("DARAJA_CONSUMER_SECRET")!;
const DARAJA_SHORT_CODE = Deno.env.get("DARAJA_SHORT_CODE")!;     // Your Paybill number
const DARAJA_PASSKEY = Deno.env.get("DARAJA_PASSKEY")!;            // Lipa Na M-Pesa passkey
const MPESA_CALLBACK_URL = Deno.env.get("MPESA_CALLBACK_URL")!;   // URL of your mpesa-callback function

// TumaFly's flat service fee in KES (your margin)
const TUMAFLY_SERVICE_FEE_KES = 1500;

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
    // Apply 3% FX buffer to protect against rate movement
    if (rate) return Math.round(amount * rate * 1.03);
  } catch {}
  return Math.round(amount * (FALLBACK_RATES[fromCurrency] || 130) * 1.03);
}

// Daraja OAuth — exchange consumer key/secret for short-lived access token
async function getDarajaToken(): Promise<string> {
  const auth = btoa(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`);
  const res = await fetch(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Daraja auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Daraja expects:
//   Timestamp: YYYYMMDDHHmmss (no separators)
//   Password:  base64(shortcode + passkey + timestamp)
function buildDarajaTimestampAndPassword(): { timestamp: string; password: string } {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const timestamp =
    `${now.getFullYear()}` +
    `${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}` +
    `${pad(now.getHours())}` +
    `${pad(now.getMinutes())}` +
    `${pad(now.getSeconds())}`;
  const password = btoa(`${DARAJA_SHORT_CODE}${DARAJA_PASSKEY}${timestamp}`);
  return { timestamp, password };
}

// Normalize phone to Safaricom's expected 2547XXXXXXXX format
function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "254" + digits.slice(1);
  if (digits.startsWith("7") && digits.length === 9) return "254" + digits;
  if (digits.startsWith("1") && digits.length === 9) return "254" + digits; // Safaricom new prefixes
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { offer_id, passengers, contact, phone_number } = await req.json();

    // 1. Validate
    if (!offer_id || !passengers?.length || !contact?.email || !phone_number) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const normalizedPhone = normalizePhone(phone_number);
    if (!normalizedPhone) {
      return new Response(JSON.stringify({
        error: "Invalid phone number. Please use a Safaricom number (07XX, 01XX, or +2547XX).",
      }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 2. Re-fetch offer
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

    // 3. Pricing — no processing fee for Daraja (customer pays M-Pesa's own fees)
    const baseAmountKES = await toKES(
      parseFloat(offer.total_amount),
      offer.total_currency
    );
    const totalKES = baseAmountKES + TUMAFLY_SERVICE_FEE_KES;

    // 4. Create pending_booking
    const merchantRef = `TF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { data: pending, error: insertErr } = await supabase
      .from("pending_bookings")
      .insert({
        pesapal_order_id: merchantRef,  // reused as universal merchant_ref
        duffel_offer_id: offer_id,
        passengers,
        contact: { ...contact, phone_number: normalizedPhone },
        base_amount_kes: baseAmountKES,
        service_fee_kes: TUMAFLY_SERVICE_FEE_KES,
        processing_fee_kes: 0,   // no aggregator fee for Daraja
        total_kes: totalKES,
        payment_method: "mpesa_stk",
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

    // 5. Initiate STK push
    const token = await getDarajaToken();
    const { timestamp, password } = buildDarajaTimestampAndPassword();

    const stkRes = await fetch(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: DARAJA_SHORT_CODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: totalKES,
        PartyA: normalizedPhone,
        PartyB: DARAJA_SHORT_CODE,
        PhoneNumber: normalizedPhone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: merchantRef,
        TransactionDesc: `TumaFly ${offer.slices[0].origin.iata_code}-${offer.slices[0].destination.iata_code}`,
      }),
    });

    const stkData = await stkRes.json();

    // Daraja returns ResponseCode "0" on success
    if (stkData.ResponseCode !== "0") {
      await supabase
        .from("pending_bookings")
        .update({ status: "stk_failed_to_send" })
        .eq("id", pending.id);

      return new Response(JSON.stringify({
        error: "Failed to send M-Pesa prompt. Please try again or use Pay Bill manually.",
        daraja_error: stkData,
        // Still give the customer the manual Pay Bill info as a fallback
        manual_paybill: {
          business_number: DARAJA_SHORT_CODE,
          account_number: merchantRef,
          amount: totalKES,
        },
      }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 6. Save Daraja IDs to pending_booking
    await supabase
      .from("pending_bookings")
      .update({
        mpesa_checkout_request_id: stkData.CheckoutRequestID,
        mpesa_merchant_request_id: stkData.MerchantRequestID,
      })
      .eq("id", pending.id);

    // 7. Return everything the frontend needs
    return new Response(JSON.stringify({
      success: true,
      merchant_ref: merchantRef,
      checkout_request_id: stkData.CheckoutRequestID,
      message: "Check your phone for the M-Pesa prompt",
      // Manual Pay Bill fallback — show on the same page in case STK fails
      manual_paybill: {
        business_number: DARAJA_SHORT_CODE,
        account_number: merchantRef,
        amount: totalKES,
      },
      breakdown: {
        base_kes: baseAmountKES,
        service_fee_kes: TUMAFLY_SERVICE_FEE_KES,
        total_kes: totalKES,
      },
    }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("create-mpesa-stk error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
