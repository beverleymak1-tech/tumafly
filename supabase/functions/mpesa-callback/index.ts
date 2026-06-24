import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
// In sandbox we skip sending seat services to /air/orders since Duffel test mode
// doesn't reliably accept them. The customer-facing seat selection still shows in
// the booking summary; we just can't reserve specific seats on a fake offer.
const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const SEND_CONFIRMATION_URL = `${SUPABASE_URL}/functions/v1/send-confirmation`;
const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// Fire-and-forget alert helper
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

// ── Mode/key mismatch guard ───────────────────────────────────────────────
// Fires once at cold start if DUFFEL_MODE doesn't match the key prefix.
// All requests refused with 503 + one CRITICAL alert per cold start.
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

// Daraja expects this exact response shape to acknowledge the callback
function darajaAck() {
  return new Response(
    JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}

// Pull a named value out of Daraja's CallbackMetadata.Item array
function getMetadataValue(items: any[], name: string): any {
  const item = items?.find(i => i.Name === name);
  return item?.Value;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // GUARD: refuse if DUFFEL_MODE and DUFFEL_API_KEY disagree.
  const guardBlock = await checkDuffelModeKeyMismatch(alertFounder, "mpesa-callback");
  if (guardBlock) return guardBlock;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const body = await req.json();
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      console.error("Invalid Daraja callback shape:", body);
      return darajaAck(); // ack anyway so Daraja doesn't retry forever
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    if (!checkoutRequestId) {
      console.error("Missing CheckoutRequestID");
      return darajaAck();
    }

    // 1. Find the pending booking
    const { data: pending, error: pendingErr } = await supabase
      .from("pending_bookings")
      .select("*")
      .eq("mpesa_checkout_request_id", checkoutRequestId)
      .maybeSingle();

    if (pendingErr || !pending) {
      console.error("Callback for unknown CheckoutRequestID:", checkoutRequestId);
      await alertFounder("UNHANDLED_ERROR", {
        message: "M-Pesa callback for unknown CheckoutRequestID",
        checkout_request_id: checkoutRequestId,
        daraja_payload: body,
      });
      return darajaAck();
    }

    // 2. Idempotency — already booked OR another worker is mid-booking.
    // "booking" status means another invocation of this webhook claimed the row
    // and is currently calling Duffel /air/orders. We must NOT try again — the
    // other worker will finalise to "booked" or "paid_booking_failed".
    if (pending.status === "booked" || pending.status === "booking") {
      console.log(`Webhook re-fired for ${pending.status} booking (${trackingId})`);
      return pesapalAck(trackingId, merchantRef, notificationType, 200);
    }

    // 3. Handle failure (any ResultCode != 0)
    if (resultCode !== 0) {
      await supabase
        .from("pending_bookings")
        .update({
          status: "payment_failed",
          daraja_result_code: resultCode,
          daraja_result_desc: resultDesc,
        })
        .eq("id", pending.id);

      await alertFounder("PAYMENT_FAILED", {
        merchant_ref: pending.pesapal_order_id,
        checkout_request_id: checkoutRequestId,
        result_code: resultCode,
        result_desc: resultDesc,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
      });

      return darajaAck();
    }

    // 4. Payment succeeded — extract metadata
    const metadata = stkCallback.CallbackMetadata?.Item || [];
    const amountPaid = getMetadataValue(metadata, "Amount");
    const mpesaReceiptNumber = getMetadataValue(metadata, "MpesaReceiptNumber");
    const transactionDate = getMetadataValue(metadata, "TransactionDate");
    const paymentPhone = getMetadataValue(metadata, "PhoneNumber");

    // 5. Amount sanity check
    if (Math.abs(amountPaid - pending.total_kes) > 1) {
      await supabase
        .from("pending_bookings")
        .update({
          status: "amount_mismatch",
          mpesa_receipt_number: mpesaReceiptNumber,
        })
        .eq("id", pending.id);

      await alertFounder("AMOUNT_MISMATCH", {
        merchant_ref: pending.pesapal_order_id,
        checkout_request_id: checkoutRequestId,
        expected_kes: pending.total_kes,
        received_kes: amountPaid,
        mpesa_receipt: mpesaReceiptNumber,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
      });

      return darajaAck();
    }

   // 6. Mark as paid (logical milestone — payment is confirmed).
   await supabase
     .from("pending_bookings")
     .update({
       status: "paid",
       mpesa_receipt_number: mpesaReceiptNumber,
       mpesa_transaction_date: transactionDate?.toString() || null,
     })
     .eq("id", pending.id);

   // 6b. Atomic claim — exactly one worker proceeds to Duffel.
   // Postgres serialises the WHERE status='paid' check with the SET status='booking'
   // write per row. If Daraja fires the callback twice (it does retry on slow
   // acks), only one update returns affected rows; the other returns an empty
   // array and bails cleanly without double-booking.
   const { data: claimed, error: claimErr } = await supabase
     .from("pending_bookings")
     .update({ status: "booking" })
     .eq("id", pending.id)
     .eq("status", "paid")
     .select();

   if (claimErr) {
     console.error("Atomic claim error:", claimErr);
     // Don't ack — let Daraja retry once Supabase is healthy again.
     await alertFounder("UNHANDLED_ERROR", {
       function: "mpesa-callback",
       message: "Atomic claim failed at booking step",
       pending_id: pending.id,
       error: claimErr.message,
     });
     // Returning darajaAck() would tell Daraja "stop retrying". We want it to
     // retry so we get another chance to finish booking. Return a non-200 shape:
     return new Response(
       JSON.stringify({ ResultCode: 1, ResultDesc: "Transient claim error, retry" }),
       { headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, status: 500 }
     );
   }
   if (!claimed || claimed.length === 0) {
     // Another worker won the race.
     console.log(`Booking already claimed by another worker for ${pending.id}`);
     return darajaAck();
   }

    // 7. Re-fetch Duffel offer (may have expired during STK push)
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
        checkout_request_id: checkoutRequestId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        mpesa_receipt: mpesaReceiptNumber,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
        passengers: pending.passengers,
        duffel_error: offerData,
      });

      return darajaAck();
    }

    const offer = offerData.data;

    // 8. Book with Duffel
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

    // 8a. Build services from stashed seat + baggage selections (set by create-payment).
    // Each seat entry on pending.contact.seats has passenger_index + service_id; each
    // baggage entry on pending.contact.baggages has passenger_index + service_id + quantity.
    // We zip the index against offer.passengers to get the Duffel passenger.id Duffel needs.
    // The total order amount has to include seat AND baggage costs, otherwise the balance
    // payment won't cover them and Duffel will reject the order.
    //
    // SANDBOX BEHAVIOUR: Duffel test mode often issues seat/baggage services that aren't
    // valid at /air/orders. We pass an empty services array AND keep offer total
    // unchanged, so the order books cleanly without extras. The customer "selected"
    // them in the UI but no actual reservation happens — fine for dev testing.
    const storedSeats: any[] = Array.isArray(pending.contact?.seats) ? pending.contact.seats : [];
    const storedBaggages: any[] = Array.isArray(pending.contact?.baggages) ? pending.contact.baggages : [];
    const services: Array<{ id: string; quantity: number; passenger_id: string }> = [];
    let extrasAmountInOfferCurrency = 0;
    if (DUFFEL_MODE !== "sandbox") {
      // Seats — always quantity 1 per service_id (Duffel issues a distinct service
      // per (segment, passenger, seat) combination).
      for (const seat of storedSeats) {
        const dpax = offerPassengers[seat.passenger_index];
        if (!dpax || !seat.service_id) continue;
        services.push({
          id: seat.service_id,
          quantity: 1,
          passenger_id: dpax.id,
        });
        // Sum the seat amounts in the offer's currency. We stored original_amount /
        // original_currency at create-payment time. Duffel always quotes seat services
        // in the same currency as the parent offer, so we treat them as additive.
        if (seat.original_amount) {
          extrasAmountInOfferCurrency += parseFloat(seat.original_amount);
        }
      }
      // Baggage — Duffel /air/orders accepts a quantity field for baggage services,
      // so we pass the validated quantity through directly. original_amount is the
      // per-unit price; multiply by quantity for the total contribution.
      for (const bag of storedBaggages) {
        const dpax = offerPassengers[bag.passenger_index];
        if (!dpax || !bag.service_id) continue;
        const qty = Number(bag.quantity) || 1;
        services.push({
          id: bag.service_id,
          quantity: qty,
          passenger_id: dpax.id,
        });
        if (bag.original_amount) {
          extrasAmountInOfferCurrency += parseFloat(bag.original_amount) * qty;
        }
      }
    }
    const orderTotalAmount = (parseFloat(offer.total_amount) + extrasAmountInOfferCurrency).toFixed(2);

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
          services, // empty array is fine — Duffel ignores it
          payments: [{
            type: "balance",
            currency: offer.total_currency,
            amount: orderTotalAmount,
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
        checkout_request_id: checkoutRequestId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        mpesa_receipt: mpesaReceiptNumber,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
        passengers: pending.passengers,
        seat_selections: storedSeats,
        duffel_error: orderData,
      });

      return darajaAck();
    }

    const order = orderData.data;
    const outbound = order.slices[0];
    const outboundSeg = outbound.segments[0];
    const returnSlice = order.slices[1] || null;
    const returnSeg = returnSlice ? returnSlice.segments[0] : null;

    // 9. Save booking
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
      payment_method: "mpesa_stk",
      mpesa_receipt_number: mpesaReceiptNumber,
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
        mpesa_receipt: mpesaReceiptNumber,
        db_error: dbErr.message,
      });
    }

    // 10. Mark pending booked with order_id + booking_reference
    await supabase
      .from("pending_bookings")
      .update({
        status: "booked",
        duffel_order_id: order.id,
        booking_reference: order.booking_reference,
      })
      .eq("id", pending.id);

    // 11. Send confirmation email. Wrapped in EdgeRuntime.waitUntil so the
    // fetch survives the response (Supabase Edge Runtime aborts in-flight
    // fetches when the handler returns — a bare `fetch().catch()` would
    // silently drop the email before it leaves the box). Daraja still gets
    // a fast callback ack because waitUntil doesn't block the response.
    const sendEmailPromise = fetch(SEND_CONFIRMATION_URL, {
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

    // @ts-ignore — EdgeRuntime is the Supabase Edge Runtime global; not in
    // standard Deno types. Fall back to awaiting if it's missing.
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(sendEmailPromise);
    } else {
      await sendEmailPromise;
    }

    return darajaAck();

  } catch (err) {
    console.error("CRITICAL: mpesa-callback unhandled error", err);
    await alertFounder("UNHANDLED_ERROR", {
      function: "mpesa-callback",
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    // Still ack — we don't want Daraja retrying forever
    return darajaAck();
  }
});