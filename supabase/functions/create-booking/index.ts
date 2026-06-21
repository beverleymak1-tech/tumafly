import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY");
const DUFFEL_BASE_URL = "https://api.duffel.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);

  try {
    const { offer_id, passengers, contact } = await req.json();

    // Step 1: Check if this offer was already booked (handles double-clicks)
    const { data: existing } = await supabase
      .from("bookings")
      .select("*")
      .eq("duffel_order_id", offer_id)
      .maybeSingle();

    // Step 2: Fetch the offer to get passenger IDs
    const offerRes = await fetch(`${DUFFEL_BASE_URL}/air/offers/${offer_id}`, {
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
      },
    });

    const offerData = await offerRes.json();

    if (!offerRes.ok) {
      return new Response(JSON.stringify({ error: offerData }), {
        status: offerRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const offer = offerData.data;

    // Step 3: Map passenger IDs
    const offerPassengers = offer.passengers;
    const mappedPassengers = passengers.map((p: any, index: number) => ({
      id: offerPassengers[index].id,
      type: p.type,
      title: p.title,
      given_name: p.given_name,
      family_name: p.family_name,
      born_on: p.born_on,
      gender: p.gender,
      email: contact.email,
      phone_number: contact.phone_number || null,
    }));

    // Step 4: Create order with Duffel
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
          selected_offers: [offer_id],
          passengers: mappedPassengers,
          payments: [{
            type: "balance",
            currency: "GBP",
            amount: offer.total_amount,
          }],
        },
      }),
    });

    const orderData = await orderRes.json();

    // Step 5: Handle "already booked" error — look up existing record
    if (!orderRes.ok) {
      const duffelError = orderData.errors?.[0];
      if (duffelError?.message?.includes("already been booked")) {
        const { data: existingBooking } = await supabase
          .from("bookings")
          .select("*")
          .eq("duffel_order_id", offer_id)
          .maybeSingle();

        if (existingBooking) {
          return new Response(JSON.stringify({
            success: true,
            already_booked: true,
            booking: {
              id: existingBooking.duffel_order_id,
              booking_reference: existingBooking.booking_reference,
              status: "confirmed",
            },
          }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({ error: orderData }), {
        status: orderRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const order = orderData.data;
    const outboundSlice = order.slices[0];
    const outboundSegment = outboundSlice.segments[0];
    const returnSlice = order.slices[1] || null;
    const returnSegment = returnSlice ? returnSlice.segments[0] : null;
    const isRoundTrip = !!returnSlice;

    // Step 6: Save to Supabase IMMEDIATELY — top priority
    const { error: dbError } = await supabase.from("bookings").insert({
      duffel_order_id: order.id,
      booking_reference: order.booking_reference,
      origin: outboundSlice.origin.iata_code,
      destination: outboundSlice.destination.iata_code,
      departure_at: outboundSegment.departing_at,
      airline: order.owner.name,
      flight_number: `${outboundSegment.marketing_carrier.iata_code}${outboundSegment.marketing_carrier_flight_number}`,
      total_amount: parseFloat(order.total_amount),
      total_currency: order.total_currency,
      passenger_name: order.passengers.map((p: any) => `${p.given_name} ${p.family_name}`).join(", "),
      passenger_email: contact.email,
      passenger_phone: contact.phone_number || null,
      passenger_count: order.passengers.length,
      status: "confirmed",
      trip_type: isRoundTrip ? "round_trip" : "one_way",
      return_date: returnSegment?.departing_at || null,
      return_airline: returnSlice ? order.owner.name : null,
      return_flight_number: returnSegment
        ? `${returnSegment.marketing_carrier.iata_code}${returnSegment.marketing_carrier_flight_number}`
        : null,
    });

    if (dbError) {
      // Log but don't fail — booking exists in Duffel, that's the source of truth
      console.error("CRITICAL: Booking confirmed in Duffel but failed to save to DB:", {
        order_id: order.id,
        booking_reference: order.booking_reference,
        error: dbError,
      });
    }

    // Step 7: Return success
    return new Response(
      JSON.stringify({
        success: true,
        booking: {
          id: order.id,
          booking_reference: order.booking_reference,
          status: "confirmed",
          total_amount: order.total_amount,
          total_currency: order.total_currency,
          passengers: order.passengers,
          slices: order.slices,
        },
      }),
      {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});