// retry-stuck-bookings
//
// Scheduled Edge Function invoked by pg_cron every minute. Scans
// pending_bookings for rows stuck in 'paid' or 'booking' state past a
// configurable timeout, claims them atomically, and drives them to a
// terminal state (booked, paid_offer_expired, paid_booking_failed,
// or paid_booking_orphan).
//
// Safety properties:
// - Atomic claim via updated_at-bounded conditional update — won't race
//   a still-alive webhook
// - Bounded batch size (5 per invocation) — limits the blast radius
//   if something goes wrong
// - Only callable with service_role auth — protects against accidental
//   public invocation

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const SEND_CONFIRMATION_URL = `${SUPABASE_URL}/functions/v1/send-confirmation`;
const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;

// Stuck-row thresholds — how long a row must sit in each state before retry
// considers it abandoned. Tune up if you see false retries; tune down if you
// want faster recovery.
const STUCK_PAID_SECONDS = 60;       // webhook crashed before claiming
const STUCK_BOOKING_SECONDS = 300;   // webhook crashed mid-Duffel-call
const BATCH_LIMIT = 5;               // max rows per invocation

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

// ── DUFFEL_MODE / DUFFEL_API_KEY mismatch guard ──────────────────────────
// Same guard as in create-payment, pesapal-webhook, mpesa-callback.
const _duffelKeyIsLive = (DUFFEL_API_KEY || "").startsWith("duffel_live_");
const _duffelKeyIsTest = (DUFFEL_API_KEY || "").startsWith("duffel_test_");
const _modeIsProduction = DUFFEL_MODE === "production";
const _modeIsSandbox = DUFFEL_MODE === "sandbox";
const DUFFEL_MODE_KEY_MISMATCH =
  (_modeIsProduction && _duffelKeyIsTest) ||
  (_modeIsSandbox && _duffelKeyIsLive);

if (DUFFEL_MODE_KEY_MISMATCH) {
  console.error(
    `CRITICAL: DUFFEL_MODE=${DUFFEL_MODE} but DUFFEL_API_KEY appears to be ` +
    `${_duffelKeyIsLive ? "live" : "test"}.`
  );
}

let _mismatchAlertFired = false;

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Auth: only service_role can invoke this. pg_cron passes the key via the
  // Authorization header (set up in the cron schedule SQL below).
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.includes(SERVICE_ROLE_KEY)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: CORS_HEADERS }
    );
  }

  // Guard
  if (DUFFEL_MODE_KEY_MISMATCH) {
    if (!_mismatchAlertFired) {
      _mismatchAlertFired = true;
      await alertFounder("UNHANDLED_ERROR", {
        severity: "CRITICAL",
        message: "retry-stuck-bookings: DUFFEL_MODE / DUFFEL_API_KEY mismatch",
        mode: DUFFEL_MODE,
      });
    }
    return new Response(
      JSON.stringify({ error: "Mode/key mismatch — refusing run" }),
      { status: 503, headers: CORS_HEADERS }
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // Find stuck rows.
    // We use `.or()` with two AND-clauses:
    //   (status='paid' AND updated_at < paidThreshold) OR
    //   (status='booking' AND updated_at < bookingThreshold)
    const now = new Date();
    const paidThreshold = new Date(now.getTime() - STUCK_PAID_SECONDS * 1000).toISOString();
    const bookingThreshold = new Date(now.getTime() - STUCK_BOOKING_SECONDS * 1000).toISOString();

    const { data: stuckRows, error: scanErr } = await supabase
      .from("pending_bookings")
      .select("*")
      .or(
        `and(status.eq.paid,updated_at.lt.${paidThreshold}),` +
        `and(status.eq.booking,updated_at.lt.${bookingThreshold})`
      )
      .order("updated_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (scanErr) {
      console.error("Scan error:", scanErr);
      await alertFounder("UNHANDLED_ERROR", {
        function: "retry-stuck-bookings",
        message: "Scan failed",
        error: scanErr.message,
      });
      return new Response(
        JSON.stringify({ error: "Scan failed" }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    if (!stuckRows || stuckRows.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0 }),
        { headers: CORS_HEADERS }
      );
    }

    const results: any[] = [];
    for (const row of stuckRows) {
      try {
        const result = await processStuckRow(supabase, row);
        results.push({ id: row.id, ...result });
      } catch (err) {
        console.error(`Processing row ${row.id} failed:`, err);
        results.push({ id: row.id, outcome: "error", error: (err as Error).message });
        await alertFounder("UNHANDLED_ERROR", {
          function: "retry-stuck-bookings",
          pending_id: row.id,
          merchant_ref: row.pesapal_order_id,
          message: "processStuckRow threw",
          error: (err as Error).message,
        });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("retry-stuck-bookings unhandled error:", err);
    await alertFounder("UNHANDLED_ERROR", {
      function: "retry-stuck-bookings",
      message: "Top-level error",
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
});

async function processStuckRow(supabase: any, row: any): Promise<{ outcome: string; detail?: string }> {
  // 1. Atomic claim: ensure the row is still stuck and grab ownership.
  // The .lt('updated_at', row.updated_at) check is what makes this race-safe
  // against a live worker that might have just touched the row — if anyone
  // else has updated it since we scanned, our claim fails.
  const { data: claimed, error: claimErr } = await supabase
    .from("pending_bookings")
    .update({ status: "booking" })
    .eq("id", row.id)
    .in("status", ["paid", "booking"])
    .lte("updated_at", row.updated_at)
    .select();

  if (claimErr) {
    return { outcome: "claim_error", detail: claimErr.message };
  }
  if (!claimed || claimed.length === 0) {
    // Someone else (probably the original webhook returning) moved the row.
    return { outcome: "skipped", detail: "row no longer stuck" };
  }

  console.log(`[retry] claimed row ${row.id} (was ${row.status}, last updated ${row.updated_at})`);

  // 2. Re-fetch the Duffel offer. May have expired.
  const offerRes = await fetch(
    `${DUFFEL_BASE_URL}/air/offers/${row.duffel_offer_id}`,
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
      .eq("id", row.id);

    await alertFounder("PAID_NO_OFFER", {
      merchant_ref: row.pesapal_order_id,
      duffel_offer_id: row.duffel_offer_id,
      amount_paid_kes: row.total_kes,
      customer_email: row.contact?.email,
      customer_phone: row.contact?.phone_number,
      passengers: row.passengers,
      duffel_error: offerData,
      source: "retry-stuck-bookings",
      previous_status: row.status,
    });

    return { outcome: "paid_offer_expired" };
  }

  const offer = offerData.data;

  // 3. Attempt the Duffel booking.
  const offerPassengers = offer.passengers;
  const mappedPassengers = row.passengers.map((p: any, i: number) => ({
    id: offerPassengers[i].id,
    type: p.type,
    title: p.title,
    given_name: p.given_name,
    family_name: p.family_name,
    born_on: p.born_on,
    gender: p.gender,
    email: row.contact.email,
    phone_number: row.contact.phone_number || null,
  }));

  // Seat services — same logic as the webhooks.
  const storedSeats: any[] = Array.isArray(row.contact?.seats) ? row.contact.seats : [];
  const services: Array<{ id: string; quantity: number; passenger_id: string }> = [];
  let seatsAmountInOfferCurrency = 0;
  if (DUFFEL_MODE !== "sandbox") {
    for (const seat of storedSeats) {
      const dpax = offerPassengers[seat.passenger_index];
      if (!dpax || !seat.service_id) continue;
      services.push({
        id: seat.service_id,
        quantity: 1,
        passenger_id: dpax.id,
      });
      if (seat.original_amount) {
        seatsAmountInOfferCurrency += parseFloat(seat.original_amount);
      }
    }
  }
  const orderTotalAmount = (parseFloat(offer.total_amount) + seatsAmountInOfferCurrency).toFixed(2);

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
        selected_offers: [row.duffel_offer_id],
        passengers: mappedPassengers,
        services,
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
    const duffelErrorMessage = orderData.errors?.[0]?.message || "";

    // SPECIAL CASE: previous worker DID create the order before crashing.
    // The order exists at Duffel but our bookings row never got written.
    // We can't recover automatically without a way to look up the existing
    // order — Duffel's error response sometimes includes the order_id, but
    // not reliably. Mark for manual reconciliation and alert.
    if (duffelErrorMessage.toLowerCase().includes("already") &&
        duffelErrorMessage.toLowerCase().includes("book")) {
      await supabase
        .from("pending_bookings")
        .update({ status: "paid_booking_orphan" })
        .eq("id", row.id);

      await alertFounder("PAID_NO_TICKET", {
        severity: "CRITICAL",
        merchant_ref: row.pesapal_order_id,
        duffel_offer_id: row.duffel_offer_id,
        amount_paid_kes: row.total_kes,
        customer_email: row.contact.email,
        customer_phone: row.contact.phone_number,
        passengers: row.passengers,
        message: "Order already exists at Duffel — needs manual reconciliation. " +
                 "Check Duffel dashboard for an order created from this offer_id, " +
                 "then manually insert the booking row.",
        source: "retry-stuck-bookings",
        duffel_error: orderData,
      });

      return { outcome: "paid_booking_orphan" };
    }

    // Normal booking failure (offer expired, sold out, insufficient balance, etc.)
    await supabase
      .from("pending_bookings")
      .update({ status: "paid_booking_failed" })
      .eq("id", row.id);

    await alertFounder("PAID_NO_TICKET", {
      merchant_ref: row.pesapal_order_id,
      duffel_offer_id: row.duffel_offer_id,
      amount_paid_kes: row.total_kes,
      customer_email: row.contact.email,
      customer_phone: row.contact.phone_number,
      passengers: row.passengers,
      seat_selections: storedSeats,
      duffel_error: orderData,
      source: "retry-stuck-bookings",
    });

    return { outcome: "paid_booking_failed" };
  }

  // 4. Order created successfully. Write bookings row and finalise.
  const order = orderData.data;
  const outbound = order.slices[0];
  const outboundSeg = outbound.segments[0];
  const returnSlice = order.slices[1] || null;
  const returnSeg = returnSlice ? returnSlice.segments[0] : null;

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
    total_paid_kes: row.total_kes,
    service_fee_kes: row.service_fee_kes,
    processing_fee_kes: row.processing_fee_kes,
    payment_method: row.payment_method || "unknown",
    pesapal_tracking_id: row.pesapal_tracking_id || null,
    mpesa_receipt_number: row.mpesa_receipt_number || null,
    passenger_name: order.passengers.map((p: any) => `${p.given_name} ${p.family_name}`).join(", "),
    passenger_email: row.contact.email,
    passenger_phone: row.contact.phone_number || null,
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
      merchant_ref: row.pesapal_order_id,
      customer_email: row.contact.email,
      db_error: dbErr.message,
      source: "retry-stuck-bookings",
    });
  }

  await supabase
    .from("pending_bookings")
    .update({
      status: "booked",
      duffel_order_id: order.id,
      booking_reference: order.booking_reference,
    })
    .eq("id", row.id);

  // 5. Send confirmation email (fire-and-forget)
  fetch(SEND_CONFIRMATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: row.contact.email,
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
      total_kes: row.total_kes,
    }),
  }).catch(err => console.error("Email send failed (non-blocking):", err));

  console.log(`[retry] booked ${row.id} → ${order.booking_reference}`);
  return { outcome: "booked", detail: order.booking_reference };
}