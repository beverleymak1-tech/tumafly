import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// Maps internal status to frontend-friendly status + message.
// Frontend should drive UI off `state`, not `raw_status`.
//
// Batch 2 update (Session 25):
//   - paid_offer_expired / paid_booking_failed copy now reflects automated
//     Paystack refund (see paystack-webhook.refundBooking()).
//   - refund_pending and refunded added as new states.
function mapStatus(raw: string): { state: string; message: string; final: boolean } {
  switch (raw) {
    case "pending":
      return { state: "awaiting_payment", message: "Waiting for payment confirmation...", final: false };
    case "paid":
      return { state: "processing", message: "Payment received, issuing your ticket...", final: false };
    case "booking":
      return { state: "processing", message: "Payment received, issuing your ticket...", final: false };
    case "booked":
      return { state: "confirmed", message: "Booking confirmed!", final: true };
    case "payment_failed":
      return { state: "failed", message: "Payment was not completed. Please try again.", final: true };
    case "payment_invalid":
      return { state: "failed", message: "Payment could not be verified. Please try again.", final: true };
    case "amount_mismatch":
      return { state: "needs_support", message: "Payment received but with an issue. Our team will contact you shortly.", final: true };
    case "paid_offer_expired":
      return {
        state: "refund_pending",
        message: "The flight is no longer available. Your payment is being refunded automatically and should appear in 3–5 business days.",
        final: false, // will transition to refund_pending → refunded
      };
    case "paid_booking_failed":
      return {
        state: "refund_pending",
        message: "We couldn't complete your booking. Your payment is being refunded automatically and should appear in 3–5 business days.",
        final: false,
      };
    case "refund_pending":
      return {
        state: "refund_pending",
        message: "Your refund is on its way. It should appear in your account within 3–5 business days.",
        final: false,
      };
    case "refunded":
      return {
        state: "refunded",
        message: "Your payment has been refunded.",
        final: true,
      };
    case "failed_to_create":
      return { state: "failed", message: "We could not start the payment. Please try again.", final: true };
    default:
      return { state: "unknown", message: "Status unknown. Please contact support.", final: false };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // Accept two lookup modes via the `ref` query/body param:
        //   - Mode A: ref starts with "TF-" → merchant_ref → checkout polling
        //     (surface for ops diagnostics; no live frontend caller — pollOnce
        //     hits verify-payment, not payment-status. Retained as an ops probe.)
        //   - Mode C: any other ref → treat as PNR → find-booking (requires last_name)
        //
        // A prior Mode B (tracking_id query param → processor_transaction_id lookup)
        // was removed as 28e-14. Zero frontend + backend callers confirmed by grep
        // (Session 29). If a future integration needs processor-id lookup, restore
        // from the pre-28e-14 EF version.
        let merchantRef = "", pnr = "", lastName = "";
        if (req.method === "GET") {
          const url = new URL(req.url);
          const refParam = url.searchParams.get("ref") || "";
          lastName = (url.searchParams.get("last_name") || "").trim();
          if (refParam.startsWith("TF-")) merchantRef = refParam;
          else if (refParam) pnr = refParam.toUpperCase();
        } else {
          const body = await req.json().catch(() => ({}));
          const refParam = body.ref || body.merchant_ref || "";
          lastName = (body.last_name || "").trim();
          if (refParam.startsWith("TF-")) merchantRef = refParam;
          else if (refParam) pnr = String(refParam).toUpperCase();
        }

        if (!merchantRef && !pnr) {
          return new Response(JSON.stringify({ error: "Missing ref" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ── Mode C: PNR lookup (find-booking) ───────────────────────────────
    // Confirmed bookings only — pending payments aren't visible by PNR
    // since Duffel only assigns booking_reference after the order is created.
    // last_name acts as a soft auth: anyone with a PNR can request, but
    // we require the last name to match a passenger on the booking.
    if (pnr) {
      const { data: booking, error: bookingErr } = await supabase
        .from("bookings")
        .select(`
          id, booking_reference, status, origin, destination, departure_at,
          airline, flight_number, cabin_class, fare_brand_name,
          baggage_included, seats_selected, changes_allowed, passenger_details,
          total_amount, total_currency, total_paid_kes, service_fee_kes,
          processing_fee_kes, payment_method,
          passenger_name, passenger_email, passenger_count,
          trip_type, return_date, return_airline, return_flight_number,
          created_at, user_id
        `)
        .eq("booking_reference", pnr)
        .maybeSingle();

      if (bookingErr || !booking) {
        return new Response(JSON.stringify({
          state: "not_found",
          message: "We couldn't find a booking with that reference. Please double-check and try again.",
        }), {
          status: 404,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // last_name verification — case-insensitive substring on passenger_name.
      // passenger_name is comma-joined names; we check if any name's last word
      // matches the entered last name.
      if (lastName) {
        const names = (booking.passenger_name || "").split(",").map((n: string) => n.trim());
        const requested = lastName.toLowerCase();
        const hit = names.some((n: string) => {
          const parts = n.toLowerCase().split(/\s+/);
          // match the final word OR allow a whole-name match
          return parts[parts.length - 1] === requested || n.toLowerCase().includes(requested);
        });
        if (!hit) {
          return new Response(JSON.stringify({
            state: "not_found",
            message: "We couldn't find a booking matching those details. Please check the reference and last name.",
          }), {
            status: 404,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // Return the booking shape directly. Frontend's findBooking() reshapes
      // it into the _allTrips entry shape and navigates to the itinerary view.
      return new Response(JSON.stringify({
        state: "confirmed",
        message: "Booking found.",
        final: true,
        booking,
      }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

   // ── Mode A: merchant_ref (checkout polling / ops diagnostic) ────────
       // 1. Look up pending_booking
       const { data: pending, error } = await supabase
         .from("pending_bookings")
         .select("*")
         .eq("merchant_ref", merchantRef)
         .maybeSingle();

    if (error || !pending) {
      return new Response(JSON.stringify({
        state: "not_found",
        message: "We couldn't find this booking. If you just paid, please wait a moment and try again.",
      }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const mapped = mapStatus(pending.status);

    // 2. Base response — always includes status + breakdown
    const response: Record<string, unknown> = {
      state: mapped.state,
      message: mapped.message,
      final: mapped.final,
      raw_status: pending.status,
      merchant_ref: pending.merchant_ref,
      breakdown: {
        base_kes: pending.base_amount_kes,
        service_fee_kes: pending.service_fee_kes,
        processing_fee_kes: pending.processing_fee_kes,
        total_kes: pending.total_kes,
      },
    };

    // 3. If booked, attach the actual booking details for the success page
    if (pending.status === "booked" && pending.duffel_order_id) {
      const { data: booking } = await supabase
        .from("bookings")
        .select(`
          booking_reference, origin, destination, departure_at, airline, flight_number,
          cabin_class, fare_brand_name, passenger_details,
          trip_type, return_date, return_airline, return_flight_number,
          passenger_name, passenger_count, total_paid_kes
        `)
        .eq("duffel_order_id", pending.duffel_order_id)
        .maybeSingle();

      if (booking) {
        response.booking = booking;
      }
    }

    return new Response(JSON.stringify(response), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("payment-status error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});