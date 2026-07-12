// ============================================================================
// verify-payment — Paystack post-modal verification + booking state lookup
// ============================================================================
// Called by the frontend right after Paystack's InlineJS onSuccess callback
// fires. Two jobs:
//   1. Server-side confirmation with Paystack that payment really succeeded
//      (onSuccess in the browser isn't cryptographically trustworthy).
//   2. Report the current pending_bookings state so the frontend can:
//      - Show success view immediately (if webhook already finalized)
//      - Show "Confirming your payment..." + poll (if webhook is in-flight)
//      - Show failure state (if payment or Duffel step failed)
//      - Show refund-in-flight state (for the paid-but-no-ticket edge case,
//        now that Batch 2 fires an automated Paystack refund)
//
// The frontend polls this endpoint every ~2s until a terminal state:
//   - confirmed / failed / refund_pending / refunded / needs_support / not_found
// or a soft timeout (typically 60s). During "processing" it shows the spinner.
//
// Called from the frontend with the anon key + config.toml verify_jwt=false.
// No Turnstile check — user already passed Turnstile at initialize-payment.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const PAYSTACK_API_KEY = Deno.env.get("PAYSTACK_API_KEY")!;
const PAYSTACK_MODE = (Deno.env.get("PAYSTACK_MODE") || "test").toLowerCase();
const PAYSTACK_BASE_URL = "https://api.paystack.co";

const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

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

// ── Paystack mode/key guard ───────────────────────────────────────────────
// This EF doesn't call Duffel — no Duffel check needed. Just Paystack.
let MODE_KEY_OK = true;
let MODE_KEY_REASON = "";
{
  const isPaystackTest = PAYSTACK_API_KEY.startsWith("sk_test_");
  const isPaystackLive = PAYSTACK_API_KEY.startsWith("sk_live_");
  if (!PAYSTACK_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_API_KEY not set";
  } else if (PAYSTACK_MODE === "test" && !isPaystackTest) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_MODE=test but PAYSTACK_API_KEY is not a test key";
  } else if (PAYSTACK_MODE === "live" && !isPaystackLive) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_MODE=live but PAYSTACK_API_KEY is not a live key";
  } else if (PAYSTACK_MODE !== "test" && PAYSTACK_MODE !== "live") {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `PAYSTACK_MODE has unexpected value: "${PAYSTACK_MODE}"`;
  }
}
let modeKeyAlertFired = false;

async function checkModeKeyMismatch(source: string): Promise<Response | null> {
  if (MODE_KEY_OK) return null;
  if (!modeKeyAlertFired) {
    modeKeyAlertFired = true;
    await alertFounder("PAYSTACK_MODE_KEY_MISMATCH", { source, reason: MODE_KEY_REASON });
  }
  return new Response(
    JSON.stringify({ error: "Service temporarily unavailable. Please try again shortly." }),
    { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

// Response envelope. Terminal states end the frontend's poll loop.
//   confirmed      — booking is done, PNR ready
//   processing     — payment confirmed, webhook is finalizing (poll again)
//   failed         — payment or verification failed (customer needs to retry)
//   refund_pending — Duffel failed post-capture; automated refund issued
//   refunded       — Paystack has finalized the refund
//   needs_support  — refund automation itself failed (rare; requires human)
//   not_found      — no pending_bookings row (should never happen post-init)
type VerifyState =
  | "confirmed"
  | "processing"
  | "failed"
  | "refund_pending"
  | "refunded"
  | "needs_support"
  | "not_found";

function respond(state: VerifyState, extras: Record<string, unknown> = {}, httpStatus = 200) {
  return new Response(
    JSON.stringify({ state, ...extras }),
    { status: httpStatus, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const guardBlock = await checkModeKeyMismatch("verify-payment");
  if (guardBlock) return guardBlock;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Accept reference from JSON body OR query param (?ref=)
  let reference = "";
  if (req.method === "GET") {
    const url = new URL(req.url);
    reference = url.searchParams.get("ref") || url.searchParams.get("reference") || "";
  } else {
    const body = await req.json().catch(() => ({}));
    reference = body.reference || body.ref || body.merchant_ref || "";
  }

  if (!reference) {
    return new Response(
      JSON.stringify({ error: "Missing reference" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  try {
    // 1. Look up pending_bookings by merchant_ref (stored in pesapal_order_id column)
    const { data: pending, error: pendingErr } = await supabase
      .from("pending_bookings")
      .select("id, status, duffel_order_id, booking_reference, contact, total_kes")
      .eq("pesapal_order_id", reference)
      .maybeSingle();

    if (pendingErr) {
      console.error("[verify-payment] DB error:", pendingErr);
      return new Response(
        JSON.stringify({ error: "Lookup failed" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    if (!pending) {
      // Should not happen — every merchant_ref we generate lands in pending_bookings.
      // If it does happen, the frontend probably got a bad reference. Terminal.
      return respond("not_found", {
        message: "We couldn't find that booking. Please contact support with reference " + reference + ".",
      });
    }

    // 2. Handle terminal states straight from the DB (no need to hit Paystack).
    if (pending.status === "booked") {
      // Best-case: webhook completed, Duffel order created, PNR ready.
      // Return everything the success view needs.
      return respond("confirmed", {
        booking: {
          booking_reference: pending.booking_reference,
          duffel_order_id: pending.duffel_order_id,
        },
        message: "Your booking is confirmed.",
      });
    }

    if (pending.status === "payment_failed" || pending.status === "payment_invalid") {
      return respond("failed", {
        message: "Your payment didn't go through. Please try again.",
      });
    }

    if (pending.status === "amount_mismatch") {
      return respond("failed", {
        message: "There was an issue with the payment amount. Please contact support with reference " + reference + ".",
      });
    }

    // Refund automation states (Batch 2, Session 25). Duffel failed after
    // capture; Paystack refund is either in flight or complete.
    if (pending.status === "refund_pending") {
      return respond("refund_pending", {
        message: "We couldn't complete your booking. Your payment is being refunded automatically and should appear in 3–5 business days.",
      });
    }
    if (pending.status === "refunded") {
      return respond("refunded", {
        message: "Your payment has been refunded. It should appear in your account within 3–5 business days.",
      });
    }

    if (pending.status === "paid_offer_expired" || pending.status === "paid_booking_failed") {
      // Post-Batch-2, this window should be very brief — refundBooking()
      // transitions to refund_pending in the same request. If the frontend
      // catches this state, it means the refund call is in flight or the
      // status update hasn't landed yet. Present as refund_pending so the
      // customer doesn't see conflicting messages if they refresh.
      return respond("refund_pending", {
        message: "We couldn't complete your booking. Your payment is being refunded automatically and should appear in 3–5 business days.",
      });
    }

    // 3. Intermediate states — webhook is in flight. Tell frontend to poll.
    if (pending.status === "paid" || pending.status === "booking") {
      return respond("processing", {
        message: "Confirming your payment...",
      });
    }

    // 4. Status is still 'pending' — webhook hasn't fired yet. This is
    //    common: the frontend often reaches this endpoint before Paystack's
    //    server-to-server webhook lands. Ask Paystack directly, but DON'T
    //    write to pending_bookings — the webhook is the single source of
    //    truth for state transitions (idempotency + atomic claim live there).
    //
    //    We only need to distinguish "Paystack says it succeeded, webhook
    //    should arrive momentarily" from "Paystack says it failed, this
    //    booking will never succeed."
    const verifyRes = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_API_KEY}`,
          Accept: "application/json",
        },
      },
    );
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok) {
      // Paystack returned non-2xx. Could be a transient issue on their side.
      // Treat as processing so the frontend polls again.
      console.warn("[verify-payment] Paystack verify non-2xx:", verifyRes.status, verifyData);
      return respond("processing", {
        message: "Confirming your payment...",
      });
    }

    const pStatus = verifyData?.data?.status || "";
    if (pStatus === "success") {
      // Paystack confirms payment. Webhook should fire any moment now.
      return respond("processing", {
        message: "Confirming your payment...",
      });
    }
    if (pStatus === "failed" || pStatus === "abandoned" || pStatus === "reversed") {
      // Paystack terminal-failed. Webhook won't rescue this. Mark the DB
      // so retry-stuck-bookings doesn't waste effort on it.
      await supabase
        .from("pending_bookings")
        .update({ status: "payment_failed" })
        .eq("id", pending.id)
        .eq("status", "pending"); // atomic — only update if still pending

      return respond("failed", {
        message: pStatus === "abandoned"
          ? "The payment was cancelled. Please try again."
          : "Your payment didn't go through. Please try again.",
      });
    }

    // pStatus is 'ongoing' or 'pending' or something unrecognised —
    // still processing on Paystack's side.
    return respond("processing", {
      message: "Confirming your payment...",
    });

  } catch (err) {
    console.error("[verify-payment] unhandled error:", err);
    await alertFounder("UNHANDLED_ERROR", {
      source: "verify-payment",
      reference,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});