import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const PESAPAL_BASE_URL = Deno.env.get("PESAPAL_BASE_URL")!;
const PESAPAL_CONSUMER_KEY = Deno.env.get("PESAPAL_CONSUMER_KEY")!;
const PESAPAL_CONSUMER_SECRET = Deno.env.get("PESAPAL_CONSUMER_SECRET")!;
const SEND_CONFIRMATION_URL = `${SUPABASE_URL}/functions/v1/send-confirmation`;
const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

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

// Fire-and-forget alert to the founder. Never blocks the webhook response.
async function alertFounder(alertType: string, context: Record<string, unknown>) {
  try {
    await fetch(ALERT_FOUNDER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ alert_type: alertType, context }),
    });
  } catch (err) {
    console.error("Failed to send alert:", alertType, err);
  }
}

function pesapalAck(trackingId: string, merchantRef: string, notificationType: string, status: number) {
  return new Response(JSON.stringify({
    orderNotificationType: notificationType,
    orderTrackingId: trackingId,
    orderMerchantReference: merchantRef,
    status,
  }), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    status: 200,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let trackingId = "", merchantRef = "", notificationType = "IPNCHANGE";
  if (req.method === "GET") {
    const url = new URL(req.url);
    trackingId = url.searchParams.get("OrderTrackingId") || "";
    merchantRef = url.searchParams.get("OrderMerchantReference") || "";
    notificationType = url.searchParams.get("OrderNotificationType") || "IPNCHANGE";
  } else {
    const body = await req.json().catch(() => ({}));
    trackingId = body.OrderTrackingId || body.orderTrackingId || "";
    merchantRef = body.OrderMerchantReference || body.orderMerchantReference || "";
    notificationType = body.OrderNotificationType || body.orderNotificationType || "IPNCHANGE";
  }

  if (!trackingId) {
    console.error("Webhook called with no OrderTrackingId");
    return pesapalAck(trackingId, merchantRef, notificationType, 500);
  }

  try {
    // 1. Find pending booking
    const { data: pending, error: pendingErr } = await supabase
      .from("pending_bookings")
      .select("*")
      .eq("pesapal_tracking_id", trackingId)
      .maybeSingle();

    if (pendingErr || !pending) {
      console.error("CRITICAL: Webhook for unknown tracking ID:", trackingId);
      await alertFounder("UNHANDLED_ERROR", {
        message: "Webhook fired for unknown tracking ID",
        tracking_id: trackingId,
        merchant_ref: merchantRef,
      });
      return pesapalAck(trackingId, merchantRef, notificationType, 500);
    }

    // 2. Idempotency — already booked
    if (pending.status === "booked") {
      console.log(`Webhook re-fired for already-booked ${trackingId}`);
      return pesapalAck(trackingId, merchantRef, notificationType, 200);
    }

    // 3. Verify payment status with Pesapal
    const token = await getPesapalToken();
    const statusRes = await fetch(
      `${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${trackingId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    const statusData = await statusRes.json();

    const statusCode = statusData.status_code;
    const paymentMethod = (statusData.payment_method || "unknown").toLowerCase();

    if (statusCode !== 1) {
      const newStatus = statusCode === 2 ? "payment_failed" : "payment_invalid";
      await supabase
        .from("pending_bookings")
        .update({ status: newStatus, payment_method: paymentMethod })
        .eq("id", pending.id);

      await alertFounder("PAYMENT_FAILED", {
        merchant_ref: pending.pesapal_order_id,
        tracking_id: trackingId,
        pesapal_status_code: statusCode,
        pesapal_status_desc: statusData.payment_status_description,
        customer_email: pending.contact.email,
      });

      return pesapalAck(trackingId, merchantRef, notificationType, 200);
    }

    // 4. Amount sanity check
    const paidAmount = parseFloat(statusData.amount);
    if (Math.abs(paidAmount - pending.total_kes) > 1) {
      await supabase
        .from("pending_bookings")
        .update({ status: "amount_mismatch", payment_method: paymentMethod })
        .eq("id", pending.id);

      await alertFounder("AMOUNT_MISMATCH", {
        merchant_ref: pending.pesapal_order_id,
        tracking_id: trackingId,
        expected_kes: pending.total_kes,
        received_kes: paidAmount,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
      });

      return pesapalAck(trackingId, merchantRef, notificationType, 200);
    }

    // 5. Mark as paid before booking (so we don't double-book on retry)
    await supabase
      .from("pending_bookings")
      .update({ status: "paid", payment_method: paymentMethod })
      .eq("id", pending.id);

    // 6. Re-fetch offer (may have expired during payment)
    const offerRes = await fetch(
      `${DUFFEL_BASE_URL}/air/offers/${pending.duffel_offer_id}`,
      { headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
      }}
    );
    const offerData = await offerRes.json();

    if (!offerRes.ok) {
      await supabase
        .from("pending_bookings")
        .update({ status: "paid_offer_expired" })
        .eq("id", pending.id);

      await alertFounder("PAID_NO_OFFER", {
        merchant_ref: pending.pesapal_order_id,
        tracking_id: trackingId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
        passengers: pending.passengers,
        duffel_error: offerData,
      });

      return pesapalAck(trackingId, merchantRef, notificationType, 200);
    }

    const offer = offerData.data;

    // 7. Book with Duffel
    const offerPassengers = offer.passengers;
    const mappedPassengers = pending.passengers.map((p: any, i: number) => ({
      id: offerPassengers[i].id,
      type: p.type,
      title: p.title,
      given_name: p.given_name,
      family_name: p.family_name,
      born_on: p.born_on,
      gender: p.gender,
      email: pending.contact.email,
      phone_number: pending.contact.phone_number || null,
    }));

    const orderRes = await fetch(`${DUFFEL_BASE_URL}/air/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
        Accept: "application/json",
      },
      body: JSON.stringify({
        data: {
          type: "instant",
          selected_offers: [pending.duffel_offer_id],
          passengers: mappedPassengers,
          payments: [{
            type: "balance",
            currency: offer.total_currency,
            amount: offer.total_amount,
          }],
        },
      }),
    });
    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      await supabase
        .from("pending_bookings")
        .update({ status: "paid_booking_failed" })
        .eq("id", pending.id);

      await alertFounder("PAID_NO_TICKET", {
        merchant_ref: pending.pesapal_order_id,
        tracking_id: trackingId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
        passengers: pending.passengers,
        duffel_error: orderData,
      });

      return pesapalAck(trackingId, merchantRef, notificationType, 200);
    }

    const order = orderData.data;
    const outbound = order.slices[0];
    const outboundSeg = outbound.segments[0];
    const returnSlice = order.slices[1] || null;
    const returnSeg = returnSlice ? returnSlice.segments[0] : null;

    // 8. Save booking
    const { error: dbErr } = await supabase.from("bookings").insert({
      duffel_order_id: order.id,
      booking_reference: order.booking_reference,
      origin: outbound.origin.iata_code,
      destination: outbound.destination.iata_code,
      departure_at: outboundSeg.departing_at,
      airline: order.owner.name,
      flight_number: `${outboundSeg.marketing_carrier.iata_code}${outboundSeg.marketing_carrier_flight_number}`,
      total_amount: parseFloat(order.total_amount),
      total_currency: order.total_currency,
      total_paid_kes: pending.total_kes,
      service_fee_kes: pending.service_fee_kes,
      processing_fee_kes: pending.processing_fee_kes,
      payment_method: paymentMethod,
      pesapal_tracking_id: trackingId,
      pesapal_confirmation_code: statusData.confirmation_code || null,
      passenger_name: order.passengers.map((p: any) => `${p.given_name} ${p.family_name}`).join(", "),
      passenger_email: pending.contact.email,
      passenger_phone: pending.contact.phone_number || null,
      passenger_count: order.passengers.length,
      status: "confirmed",
      trip_type: returnSlice ? "round_trip" : "one_way",
      return_date: returnSeg?.departing_at || null,
      return_airline: returnSlice ? order.owner.name : null,
      return_flight_number: returnSeg
        ? `${returnSeg.marketing_carrier.iata_code}${returnSeg.marketing_carrier_flight_number}`
        : null,
    });

    if (dbErr) {
      await alertFounder("BOOKED_NO_DB_RECORD", {
        duffel_order_id: order.id,
        booking_reference: order.booking_reference,
        merchant_ref: pending.pesapal_order_id,
        customer_email: pending.contact.email,
        db_error: dbErr.message,
      });
    }

    // 9. Mark pending_booking booked WITH order_id + booking_reference
    await supabase
      .from("pending_bookings")
      .update({
        status: "booked",
        duffel_order_id: order.id,
        booking_reference: order.booking_reference,
      })
      .eq("id", pending.id);

    // 10. Send confirmation email (fire-and-forget)
    fetch(SEND_CONFIRMATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: pending.contact.email,
        booking_reference: order.booking_reference,
        airline: order.owner.name,
        origin: outbound.origin.iata_code,
        destination: outbound.destination.iata_code,
        departure: outboundSeg.departing_at,
        arrival: outbound.segments[outbound.segments.length - 1].arriving_at,
        return_airline: returnSlice ? order.owner.name : null,
        return_departure: returnSeg?.departing_at || null,
        return_arrival: returnSlice
          ? returnSlice.segments[returnSlice.segments.length - 1].arriving_at
          : null,
        passengers: order.passengers,
        trip_type: returnSlice ? "round" : "one_way",
        total_kes: pending.total_kes,
      }),
    }).catch(err => console.error("Email send failed (non-blocking):", err));

    return pesapalAck(trackingId, merchantRef, notificationType, 200);

  } catch (err) {
    console.error("CRITICAL: webhook unhandled error", err);
    await alertFounder("UNHANDLED_ERROR", {
      tracking_id: trackingId,
      merchant_ref: merchantRef,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return pesapalAck(trackingId, merchantRef, notificationType, 500);
  }
});
