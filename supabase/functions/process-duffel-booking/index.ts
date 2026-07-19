// ============================================================================
// process-duffel-booking — async Duffel order creation
// ============================================================================
// Session 28b commit #7b-ii. Triggered by a Supabase DB webhook on
// pending_bookings UPDATE where status transitions paid → duffel_pending
// (paystack-webhook makes that transition after payment + offer-liveness
// checks pass, then returns 200 immediately — hence "async decoupling").
//
// This EF is the "post-payment, pre-ticket" worker. Responsibilities:
//   - Re-check Duffel offer liveness (defense in depth vs paystack-webhook)
//   - POST /air/orders with Duffel-Idempotency-Key = pending.id
//   - Handle six response branches per Session 28b Handoff §4.2:
//       Branch 1: 200 + documents populated → INSERT bookings, transition
//                 duffel_pending → booked, fire send-confirmation
//       Branch 2: 200 + documents empty     → INSERT bookings, transition
//                 duffel_pending → pnr_issued, no email; #9 reconciler
//                 sweeps for documents and fires email later
//       Branch 3: 202 accepted (rare)       → stay at duffel_pending; #9's
//                 reconciler polls GET /air/orders?duffel_idempotency_key
//                 (diverges from handoff §4.2 branch 3 which said pnr_issued
//                 — that would be semantically wrong when no PNR exists)
//       Branch 4: 4xx offer-dead            → paid_offer_expired + refund
//       Branch 5: 4xx/5xx other             → paid_booking_failed + refund
//       Branch 6: network / timeout / ambig → return 500, DB webhook retries
//
// Auth: x-webhook-secret header verified against
//       PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET env var (constant-time compare).
//
// Idempotency guarantees:
//   - Duffel-Idempotency-Key: <pending.id> ensures POST /air/orders is
//     safely retryable (Duffel returns existing order on second call)
//   - All pending_bookings.status UPDATEs use compare-and-set on
//     `status = 'duffel_pending'` so concurrent handlers can't step on
//     each other or regress state
//   - Pre-INSERT check on bookings prevents duplicates if a prior run
//     died between INSERT and pending_bookings UPDATE
//   - confirmation_email_sent_at atomic guard (WHERE ... IS NULL)
//     prevents double emails across the three fire sites (#7b-ii, #8, #9)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  DUFFEL_API_KEY, DUFFEL_BASE_URL, DUFFEL_MODE,
  SUPABASE_URL, SERVICE_ROLE_KEY,
  PAYSTACK_API_KEY, PAYSTACK_BASE_URL,
  SEND_CONFIRMATION_URL,
  CORS_HEADERS,
  alertFounder,
  checkModeKeyMismatch,
  refundBooking,
} from "../_shared/duffel-helpers.ts";

const WEBHOOK_SECRET = Deno.env.get("PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET") || "";

// ── Constant-time compare (webhook secret verification) ───────────────────
function safeCompare(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Duffel error classifier ───────────────────────────────────────────────
// Routes offer-related codes to paid_offer_expired; everything else to
// paid_booking_failed. Duffel error codes come at errors[].code.
function classifyDuffelError(errorData: any): "offer_dead" | "book_failed" {
  const errors = Array.isArray(errorData?.errors) ? errorData.errors : [];
  const offerCodes = new Set([
    "offer_expired",
    "offer_no_longer_available",
    "offer_request_already_booked",
  ]);
  for (const e of errors) {
    if (offerCodes.has(String(e?.code || ""))) return "offer_dead";
  }
  return "book_failed";
}

// ── Paystack helpers (kept in sync with paystack-webhook) ─────────────────
function normalizePaystackChannel(channel: string | null | undefined): string {
  if (!channel) return "unknown";
  const c = String(channel).toLowerCase();
  if (c === "card") return "card";
  if (c === "mobile_money" || c === "mpesa") return "mpesa";
  if (c === "bank" || c === "bank_transfer") return "bank";
  if (c === "ussd") return "ussd";
  if (c === "qr") return "qr";
  return c;
}

function extractLast4FromAuth(authorization: any): string | null {
  if (!authorization || typeof authorization !== "object") return null;
  const last4 = authorization.last4;
  if (typeof last4 === "string" && last4.length === 4) return last4;
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // 1. Verify webhook secret (constant-time compare)
  const receivedSecret = req.headers.get("x-webhook-secret") || "";
  if (!safeCompare(receivedSecret, WEBHOOK_SECRET)) {
    console.error("[process-duffel-booking] Missing/invalid x-webhook-secret");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 2. Mode/key sanity check (503 if mode ↔ key mismatch)
  const modeGuard = await checkModeKeyMismatch("process-duffel-booking");
  if (modeGuard) return modeGuard;

  // 3. Parse DB webhook payload → extract pending_booking_id
  let pendingId: string = "";
  try {
    const payload = await req.json();
    pendingId = payload?.record?.id || "";
    if (!pendingId) throw new Error("No record.id in webhook payload");
  } catch (err) {
    console.error("[process-duffel-booking] Invalid payload:", err);
    return new Response(JSON.stringify({ error: "Invalid payload" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // 4. Entry-point double-fire guard: re-read live status
    const { data: pending, error: pendingErr } = await supabase
      .from("pending_bookings")
      .select("*")
      .eq("id", pendingId)
      .maybeSingle();

    if (pendingErr || !pending) {
      console.error(`[process-duffel-booking] Pending row not found: ${pendingId}`, pendingErr);
      await alertFounder("PROCESS_DUFFEL_PENDING_NOT_FOUND", {
        pending_booking_id: pendingId,
        db_error: pendingErr?.message,
      });
      // 200 — don't retry a nonexistent row.
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    if (pending.status !== "duffel_pending") {
      console.log(`[process-duffel-booking] Entry guard: status is ${pending.status}, not duffel_pending — no-op bail (${pending.pesapal_order_id})`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    const reference = pending.pesapal_order_id;    // merchant_ref (TF-…)
    const paystackTxId = pending.pesapal_tracking_id; // Paystack tx id

    // 5. Fetch full Paystack transaction — needed for authorization_code
    //    and payment_account_last4 columns on bookings. Same verify call
    //    paystack-webhook makes pre-atomic-claim; re-fetching keeps this
    //    EF self-contained without adding new pending_bookings columns.
    let authorizationCode: string | null = null;
    let paymentAccountLast4: string | null = null;
    let paystackChannel: string = normalizePaystackChannel(pending.payment_method);
    try {
      const verifyRes = await fetch(
        `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: {
          Authorization: `Bearer ${PAYSTACK_API_KEY}`,
          Accept: "application/json",
        }},
      );
      const verifyData = await verifyRes.json();
      if (verifyRes.ok && verifyData?.status && verifyData?.data?.status === "success") {
        const vd = verifyData.data;
        authorizationCode = vd.authorization?.authorization_code || null;
        const cardLast4 = extractLast4FromAuth(vd.authorization);
        paystackChannel = normalizePaystackChannel(vd.channel || pending.payment_method);
        const mpesaMobile = paystackChannel === "mpesa"
          ? (vd.customer?.phone || vd.authorization?.mobile_money?.phone || null)
          : null;
        paymentAccountLast4 = cardLast4 || ((phone: string | null) => {
          if (!phone) return null;
          const digits = String(phone).replace(/\D/g, "");
          return digits.length >= 4 ? digits.slice(-4) : null;
        })(mpesaMobile);
      } else {
        console.warn("[process-duffel-booking] Paystack verify disagreed (soft-degrade):", verifyData);
        await alertFounder("PROCESS_DUFFEL_PAYSTACK_VERIFY_MISMATCH", {
          merchant_ref: reference,
          paystack_tx_id: paystackTxId,
          pending_booking_id: pending.id,
          verify_response: verifyData,
        });
      }
    } catch (err) {
      // Network hiccup on verify. Booking-critical fields will be NULL —
      // acceptable soft-degrade. Continue.
      console.warn("[process-duffel-booking] Paystack verify threw:", err);
    }

    // 6. Re-check Duffel offer liveness (defense in depth)
    const offerRes = await fetch(
      `${DUFFEL_BASE_URL}/air/offers/${pending.duffel_offer_id}`,
      { headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
      }},
    );
    const offerData = await offerRes.json();

    if (!offerRes.ok) {
      // Offer died between paystack-webhook's check and now. Refund path.
      const claim = await supabase
        .from("pending_bookings")
        .update({ status: "paid_offer_expired" })
        .eq("id", pending.id)
        .eq("status", "duffel_pending")
        .select();
      if (!claim.data || claim.data.length === 0) {
        console.log("[process-duffel-booking] Concurrent transition on offer-dead branch, bailing");
        return new Response("ok", { status: 200, headers: CORS_HEADERS });
      }
      await alertFounder("PAID_NO_OFFER", {
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        customer_email: pending.contact?.email,
        customer_phone: pending.contact?.phone_number,
        passengers: pending.passengers,
        duffel_error: offerData,
        source: "process-duffel-booking",
      });
      await refundBooking(supabase, "paid_offer_expired", pending, paystackTxId, reference);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    const offer = offerData.data;
    const offerPassengers = offer.passengers;

    // 7. Build mapped passengers (identical to pre-refactor lines 620–631)
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

    // 7a. Build services with sandbox soft-skip (identical to pre-refactor
    //     lines 636–662)
    const storedSeats: any[] = Array.isArray(pending.contact?.seats) ? pending.contact.seats : [];
    const storedBaggages: any[] = Array.isArray(pending.contact?.baggages) ? pending.contact.baggages : [];
    const services: Array<{ id: string; quantity: number; passenger_id: string }> = [];
    let extrasAmountInOfferCurrency = 0;
    if (DUFFEL_MODE !== "sandbox") {
      for (const seat of storedSeats) {
        const dpax = offerPassengers[seat.passenger_index];
        if (!dpax || !seat.service_id) continue;
        services.push({ id: seat.service_id, quantity: 1, passenger_id: dpax.id });
        if (seat.original_amount) extrasAmountInOfferCurrency += parseFloat(seat.original_amount);
      }
      for (const bag of storedBaggages) {
        const dpax = offerPassengers[bag.passenger_index];
        if (!dpax || !bag.service_id) continue;
        const qty = Number(bag.quantity) || 1;
        services.push({ id: bag.service_id, quantity: qty, passenger_id: dpax.id });
        if (bag.original_amount) extrasAmountInOfferCurrency += parseFloat(bag.original_amount) * qty;
      }
    }
    const orderTotalAmount = (parseFloat(offer.total_amount) + extrasAmountInOfferCurrency).toFixed(2);

    // 8. POST /air/orders with Duffel-Idempotency-Key
    let orderRes: Response;
    let orderRespData: any;
    try {
      orderRes = await fetch(`${DUFFEL_BASE_URL}/air/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Content-Type": "application/json",
          "Duffel-Version": "v2",
          "Duffel-Idempotency-Key": pending.id,
          Accept: "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "instant",
            selected_offers: [pending.duffel_offer_id],
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
      orderRespData = await orderRes.json();
    } catch (err) {
      // Branch 6: network / timeout / DNS. Row stays at duffel_pending.
      // Return non-2xx → DB webhook retries. Idempotency key ensures Duffel
      // won't create a duplicate on retry.
      console.error("[process-duffel-booking] Duffel POST /air/orders threw:", err);
      await alertFounder("PROCESS_DUFFEL_NETWORK_ERROR", {
        merchant_ref: reference,
        pending_booking_id: pending.id,
        error: (err as Error).message,
      });
      return new Response(JSON.stringify({ error: "Duffel network error" }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 9. Branches 4 & 5 — Duffel error
    if (!orderRes.ok) {
      const errorClass = classifyDuffelError(orderRespData);
      const targetStatus = errorClass === "offer_dead"
        ? "paid_offer_expired"
        : "paid_booking_failed";
      const alertType = errorClass === "offer_dead" ? "PAID_NO_OFFER" : "PAID_NO_TICKET";
      const refundReason = errorClass === "offer_dead"
        ? "paid_offer_expired" as const
        : "paid_booking_failed" as const;

      const claim = await supabase
        .from("pending_bookings")
        .update({ status: targetStatus })
        .eq("id", pending.id)
        .eq("status", "duffel_pending")
        .select();
      if (!claim.data || claim.data.length === 0) {
        console.log(`[process-duffel-booking] Concurrent transition on Duffel-fail branch, bailing (${errorClass})`);
        return new Response("ok", { status: 200, headers: CORS_HEADERS });
      }
      await alertFounder(alertType, {
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        customer_email: pending.contact?.email,
        customer_phone: pending.contact?.phone_number,
        passengers: pending.passengers,
        seat_selections: storedSeats,
        baggage_selections: storedBaggages,
        duffel_http_status: orderRes.status,
        duffel_error: orderRespData,
        error_class: errorClass,
        source: "process-duffel-booking",
      });
      await refundBooking(supabase, refundReason, pending, paystackTxId, reference);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // Branch 3 — 202 accepted (rare with type:"instant"). Diverges from
    // handoff §4.2: no PNR exists yet, so pnr_issued would be semantically
    // wrong. Keep at duffel_pending; #9's reconciler polls
    // GET /air/orders?duffel_idempotency_key=<pending.id>.
    if (orderRes.status === 202 || !orderRespData?.data?.id) {
      console.log(`[process-duffel-booking] 202 async accepted for ${reference}, awaiting reconciler`);
      await alertFounder("DUFFEL_ORDER_ACCEPTED_ASYNC", {
        merchant_ref: reference,
        pending_booking_id: pending.id,
        duffel_http_status: orderRes.status,
      });
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // Branches 1 & 2 — Duffel 200 with order data
    const order = orderRespData.data;
    const documents = Array.isArray(order.documents) ? order.documents : [];
    const documentsPopulated = documents.some((d: any) =>
      (d?.type === "electronic_ticket" || d?.type === "ticket") && d?.unique_identifier
    );

    const outbound = order.slices[0];
    const outboundSeg = outbound.segments[0];
    const returnSlice = order.slices[1] || null;
    const returnSeg = returnSlice ? returnSlice.segments[0] : null;

    // Derive itinerary-detail fields (identical to pre-refactor lines 726–758)
    const sampleCabin =
      offer?.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class
      || offer?.slices?.[0]?.fare_brand_name
      || null;
    const fareBrandName =
      offer?.slices?.[0]?.fare_brand_name
      || offer?.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class_marketing_name
      || null;
    const baggageIncluded = (() => {
      try {
        const bags = offer?.slices?.[0]?.segments?.[0]?.passengers?.[0]?.baggages || [];
        return bags.some((b: any) => b?.type === "checked" && (b?.quantity || 0) > 0);
      } catch (_) { return false; }
    })();
    const seatsSelected = storedSeats.length > 0;
    const changesAllowed = offer?.conditions?.change_before_departure?.allowed ?? null;

    const storedSeatsByPaxAndSeg: Record<string, string> = {};
    for (const s of storedSeats) {
      const key = `${s.passenger_index}::${s.segment_id || ''}`;
      if (s.designator) storedSeatsByPaxAndSeg[key] = s.designator;
    }

    const electronicTickets = documents
      .filter((d: any) => d?.type === "electronic_ticket" || d?.type === "ticket")
      .map((d: any) => d?.unique_identifier)
      .filter(Boolean);

    const passengerDetails = (order.passengers || []).map((p: any, paxIdx: number) => {
      const segments: any[] = [];
      for (const slice of (order.slices || [])) {
        for (const seg of (slice.segments || [])) {
          const seatService = (order.services || []).find((s: any) =>
            s.type === "seat"
            && Array.isArray(s.passenger_ids) && s.passenger_ids.includes(p.id)
            && Array.isArray(s.segment_ids) && s.segment_ids.includes(seg.id)
          );
          const storedKeyExact = `${paxIdx}::${seg.id}`;
          const storedKeyAny = `${paxIdx}::`;
          const fallbackSeat =
            storedSeatsByPaxAndSeg[storedKeyExact]
            || storedSeatsByPaxAndSeg[storedKeyAny]
            || null;
          const seatDesignator = seatService?.metadata?.designator || fallbackSeat || null;
          const tNum = electronicTickets[paxIdx] || null;
          segments.push({
            origin: seg.origin?.iata_code || null,
            destination: seg.destination?.iata_code || null,
            carrier: seg.marketing_carrier?.iata_code || null,
            flight: seg.marketing_carrier_flight_number || null,
            seat: seatDesignator,
            ticket: tNum,
          });
        }
      }
      return {
        name: `${p.given_name || ''} ${p.family_name || ''}`.trim(),
        type: p.type || null,
        segments,
      };
    });

    // 10. Idempotent bookings INSERT — check for existing first
    const { data: existingBooking } = await supabase
      .from("bookings")
      .select("id")
      .eq("pending_booking_id", pending.id)
      .maybeSingle();

    if (!existingBooking) {
      const { error: dbErr } = await supabase.from("bookings").insert({
        user_id: pending.user_id || null,
        pending_booking_id: pending.id,
        duffel_order_id: order.id,
        booking_reference: order.booking_reference,
        origin: outbound.origin.iata_code,
        destination: outbound.destination.iata_code,
        departure_at: outboundSeg.departing_at,
        airline: order.owner.name,
        flight_number: `${outboundSeg.marketing_carrier.iata_code}${outboundSeg.marketing_carrier_flight_number}`,
        cabin_class: sampleCabin,
        fare_brand_name: fareBrandName,
        baggage_included: baggageIncluded,
        seats_selected: seatsSelected,
        changes_allowed: changesAllowed,
        passenger_details: passengerDetails,
        total_amount: parseFloat(order.total_amount),
        total_currency: order.total_currency,
        total_paid_kes: pending.total_kes,
        service_fee_kes: pending.service_fee_kes,
        processing_fee_kes: pending.processing_fee_kes,
        payment_method: paystackChannel,
        payment_account_last4: paymentAccountLast4,
        pesapal_tracking_id: paystackTxId,
        pesapal_confirmation_code: authorizationCode,
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
          merchant_ref: reference,
          paystack_tx_id: paystackTxId,
          customer_email: pending.contact?.email,
          db_error: dbErr.message,
          source: "process-duffel-booking",
        });
        // Duffel booking succeeded — continue to transition pending_bookings.
        // Manual reconciliation via alert.
      }
    } else {
      console.log(`[process-duffel-booking] Bookings row already exists for pending ${pending.id}, skipping INSERT`);
    }

    // 11. Compare-and-set transition to booked or pnr_issued
    const newStatus = documentsPopulated ? "booked" : "pnr_issued";
    const transition = await supabase
      .from("pending_bookings")
      .update({
        status: newStatus,
        duffel_order_id: order.id,
        booking_reference: order.booking_reference,
      })
      .eq("id", pending.id)
      .eq("status", "duffel_pending")
      .select();

    if (!transition.data || transition.data.length === 0) {
      console.log(`[process-duffel-booking] Concurrent transition after Duffel success, ${newStatus} skipped (${reference})`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // Branch 2 — pnr_issued: no email yet, reconciler will poll for documents
    if (!documentsPopulated) {
      console.log(`[process-duffel-booking] ${reference} → pnr_issued (documents empty), awaiting reconciler`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // Branch 1 — booked: fire send-confirmation with atomic guard
    const { data: freshPending } = await supabase
      .from("pending_bookings")
      .select("confirmation_email_sent_at")
      .eq("id", pending.id)
      .maybeSingle();
    if (freshPending?.confirmation_email_sent_at) {
      console.log(`[process-duffel-booking] Confirmation already sent for ${reference}, skipping`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    const seatsKes = storedSeats.reduce((sum: number, s: any) => sum + (Number(s.cost_kes) || 0), 0);
    const baggageKes = storedBaggages.reduce((sum: number, b: any) => sum + (Number(b.total_kes) || 0), 0);
    const baggageQty = storedBaggages.reduce((sum: number, b: any) => sum + (Number(b.quantity) || 0), 0);
    const flightKes = Math.max(0, (Number(pending.base_amount_kes) || 0) - seatsKes - baggageKes);
    const breakdown_kes = {
      flight: flightKes,
      seats: seatsKes,
      baggage: baggageKes,
      baggage_qty: baggageQty,
      service_fee: Number(pending.service_fee_kes) || 0,
      processing_fee: Number(pending.processing_fee_kes) || 0,
      total: Number(pending.total_kes) || 0,
    };

    let emailRes: Response;
    try {
      emailRes = await fetch(SEND_CONFIRMATION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: pending.contact.email,
          order,
          pending: { seats: storedSeats, baggages: storedBaggages },
          breakdown_kes,
        }),
      });
    } catch (err) {
      console.error("[process-duffel-booking] send-confirmation threw:", err);
      await alertFounder("CONFIRMATION_EMAIL_FAILED", {
        merchant_ref: reference,
        pending_booking_id: pending.id,
        customer_email: pending.contact?.email,
        source: "process-duffel-booking",
        error: (err as Error).message,
      });
      // Booking is safe. Reconciler (#9) sweeps booked rows w/ NULL timestamp.
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    if (emailRes.ok) {
      await supabase
        .from("pending_bookings")
        .update({ confirmation_email_sent_at: new Date().toISOString() })
        .eq("id", pending.id)
        .is("confirmation_email_sent_at", null);
      console.log(`[process-duffel-booking] Confirmation email sent for ${reference}`);
    } else {
      const emailBody = await emailRes.text().catch(() => "");
      console.error(`[process-duffel-booking] send-confirmation ${emailRes.status}: ${emailBody}`);
      await alertFounder("CONFIRMATION_EMAIL_FAILED", {
        merchant_ref: reference,
        pending_booking_id: pending.id,
        customer_email: pending.contact?.email,
        http_status: emailRes.status,
        response_body: emailBody.slice(0, 500),
        source: "process-duffel-booking",
      });
      // Booking is safe. Reconciler sweeps.
    }

    return new Response("ok", { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    console.error("[process-duffel-booking] Unhandled:", err);
    await alertFounder("PROCESS_DUFFEL_UNHANDLED_ERROR", {
      pending_booking_id: pendingId,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    // Non-2xx → DB webhook retries. Duffel idempotency key prevents doubles.
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
