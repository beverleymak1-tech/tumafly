// supabase/functions/get-user-trips/index.ts
// Returns the authenticated user's confirmed bookings for the My Trips view.
// Auth: expects Authorization: Bearer <supabase_jwt> header.
// verify_jwt = false in config.toml (consistent with all other TumaFly EFs).
// We do our own auth.getUser() call to get the uid.
//
// Source table: `bookings` (post-payment confirmed orders). Pending payments
// don't appear here — they only show once the webhook has confirmed the order
// with Duffel and written the bookings row.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    // ── 1. Verify caller is authenticated ──────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Resolve the JWT to a uid using the service-role client.
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Fetch bookings for this user ────────────────────────────────────
    const { data: rows, error: dbError } = await adminClient
      .from("bookings")
      .select(`
        id,
        booking_reference,
        status,
        origin,
        destination,
        departure_at,
        airline,
        flight_number,
        cabin_class,
        fare_brand_name,
        baggage_included,
        seats_selected,
        changes_allowed,
        passenger_details,
        trip_type,
        return_date,
        return_airline,
        return_flight_number,
        total_amount,
        total_currency,
        passenger_name,
        passenger_email,
        passenger_phone,
        passenger_count,
        payment_account_last4,
        created_at
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (dbError) {
      console.error("[get-user-trips] DB error:", dbError);
      return new Response(JSON.stringify({ error: "Failed to fetch trips", detail: dbError.message }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Try to enrich with pending_bookings.total_kes ───────────────────
    // bookings stores the airline-currency total (GBP/USD/etc), but the user
    // saw KES when they booked. Pull the matching pending_bookings rows so we
    // can show the KES total on the trip card. Match by user_id + a created_at
    // window (pending is typically ~5-60s before bookings). Best-effort —
    // if the join misses, we just show the source-currency total.
    const userPendings = await adminClient
      .from("pending_bookings")
      .select(`
        pesapal_order_id,
        total_kes,
        base_amount_kes,
        service_fee_kes,
        processing_fee_kes,
        payment_method,
        created_at
      `)
      .eq("user_id", user.id)
      .in("status", ["booked", "paid"])
      .order("created_at", { ascending: false })
      .limit(50);

    const pendingByTime = (userPendings.data ?? []).slice();   // sorted desc

    // Pair each booking with the nearest pending row that was created BEFORE it
    // (the pending row exists before the bookings row by definition).
    const matchPendingForBooking = (bookingCreatedAt: string) => {
      const bt = new Date(bookingCreatedAt).getTime();
      let best: any = null;
      let bestGap = Infinity;
      for (const p of pendingByTime) {
        const pt = new Date(p.created_at).getTime();
        if (pt > bt) continue;   // pending must precede booking
        const gap = bt - pt;
        if (gap < bestGap) { best = p; bestGap = gap; }
      }
      // Only trust the match if it's within 5 minutes
      return bestGap < 5 * 60 * 1000 ? best : null;
    };

    // ── 4. Shape for the My Trips frontend renderer ────────────────────────
    // Frontend My Trips card expects: { offer: { slices: [...] }, totalKes,
    // pnr, merchantReference, status }
    // Frontend itinerary detail view (loadItinerary) ALSO reads: passengerEmail,
    // pesapalOrderId, baseAmountKes/serviceFeeKes/processingFeeKes, paymentMethod,
    // returnAirline/returnFlightNumber.
    const trips = (rows ?? []).map((b) => {
      const matchedPending = matchPendingForBooking(b.created_at);
      const slices: any[] = [
        {
          origin:         { iata_code: b.origin },
          destination:    { iata_code: b.destination },
          departing_at:   b.departure_at,
          airline:        b.airline,
          flight_number:  b.flight_number,
        },
      ];
      if (b.trip_type === "round_trip" && b.return_date) {
        slices.push({
          origin:         { iata_code: b.destination },
          destination:    { iata_code: b.origin },
          departing_at:   b.return_date,
          airline:        b.return_airline ?? b.airline,
          flight_number:  b.return_flight_number ?? null,
        });
      }
      return {
        id:                 b.id,
        // booking_reference (PNR) is the click handle — payment-status accepts it
        merchantReference:  b.booking_reference,
        pnr:                b.booking_reference,
        status:             b.status || "booked",
        createdAt:          b.created_at,
        totalKes:           matchedPending?.total_kes ?? null,
        // Fallback display if KES enrichment missed
        totalAmount:        b.total_amount,
        totalCurrency:      b.total_currency,
        airline:            b.airline,
        flightNumber:       b.flight_number,
        passengerName:      b.passenger_name,
        passengerEmail:     b.passenger_email,
        passengerCount:     b.passenger_count,
        // Itinerary view fields
        cabinClass:         b.cabin_class ?? null,
        fareBrandName:      b.fare_brand_name ?? null,
        baggageIncluded:    b.baggage_included ?? null,
        seatsSelected:      b.seats_selected ?? null,
        changesAllowed:     b.changes_allowed ?? null,
        passengerDetails:   b.passenger_details ?? null,
        // Itinerary view fields (only populated when pending match found)
        pesapalOrderId:     matchedPending?.pesapal_order_id ?? null,
        baseAmountKes:      matchedPending?.base_amount_kes ?? null,
        serviceFeeKes:      matchedPending?.service_fee_kes ?? null,
        processingFeeKes:   matchedPending?.processing_fee_kes ?? null,
        paymentMethod:      matchedPending?.payment_method ?? null,
        // H-redo: Last 4 of the masked Pesapal account (card number or M-Pesa
        // phone). Frontend renders inline next to the payment method, e.g.
        // "Visa ****1234". Replaces the old separate "Billing name" line.
        paymentAccountLast4: b.payment_account_last4 ?? null,
        tripType:           b.trip_type ?? "one_way",
        returnDate:         b.return_date ?? null,
        returnAirline:      b.return_airline ?? null,
        returnFlightNumber: b.return_flight_number ?? null,
        offer: { slices },
      };
    });

    return new Response(JSON.stringify({ trips }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[get-user-trips] Unexpected error:", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});