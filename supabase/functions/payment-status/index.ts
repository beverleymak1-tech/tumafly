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
function mapStatus(raw: string): { state: string; message: string; final: boolean } {
  switch (raw) {
    case "pending":
      return { state: "awaiting_payment", message: "Waiting for payment confirmation...", final: false };
    case "paid":
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
      return { state: "needs_support", message: "Payment received but the flight is no longer available. Our team will contact you to arrange a refund or alternative.", final: true };
    case "paid_booking_failed":
      return { state: "needs_support", message: "Payment received but ticket issuance failed. Our team will contact you immediately.", final: true };
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
    // Accept either merchant_ref (TF-...) or tracking_id (Pesapal's UUID)
    let merchantRef = "", trackingId = "";
    if (req.method === "GET") {
      const url = new URL(req.url);
      merchantRef = url.searchParams.get("ref") || "";
      trackingId = url.searchParams.get("tracking_id") || "";
    } else {
      const body = await req.json().catch(() => ({}));
      merchantRef = body.ref || body.merchant_ref || "";
      trackingId = body.tracking_id || "";
    }

    if (!merchantRef && !trackingId) {
      return new Response(JSON.stringify({ error: "Missing ref or tracking_id" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1. Look up pending_booking
    const query = supabase.from("pending_bookings").select("*");
    const { data: pending, error } = await (
      merchantRef
        ? query.eq("pesapal_order_id", merchantRef)
        : query.eq("pesapal_tracking_id", trackingId)
    ).maybeSingle();

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
      merchant_ref: pending.pesapal_order_id,
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
        .select("booking_reference, origin, destination, departure_at, airline, flight_number, trip_type, return_date, return_airline, return_flight_number, passenger_name, passenger_count, total_paid_kes")
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
