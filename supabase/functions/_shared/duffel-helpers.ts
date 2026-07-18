// ============================================================================
// _shared/duffel-helpers.ts — Duffel + Paystack helpers shared across EFs.
// ============================================================================
//
// Extracted in Session 28b commit #7b-i from paystack-webhook/index.ts so
// process-duffel-booking, the future order.created webhook handler
// (Session 28b commit #8), and retry-stuck-bookings (Session 28b commit #9)
// can share the same refund + alert + mode-guard logic.
//
// Supabase EFs import from _shared/ via relative path (../_shared/name.ts).
// The Supabase CLI recognizes _shared as a special folder and includes it
// in deploys of any function that imports from it.
//
// State scoping:
//   - Env vars are read at import time — same behavior as before.
//   - MODE_KEY_OK / MODE_KEY_REASON / modeKeyAlertFired are module-scope,
//     so if two functions from the same Edge Runtime worker both import
//     this file, they share the same guard state. This is CORRECT — we
//     want one alert per cold start regardless of how many functions
//     triggered the check.
// ============================================================================

// ── Env vars ──────────────────────────────────────────────────────────────

export const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
export const DUFFEL_BASE_URL = "https://api.duffel.com";
export const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

export const PAYSTACK_API_KEY = Deno.env.get("PAYSTACK_API_KEY")!;
export const PAYSTACK_MODE = (Deno.env.get("PAYSTACK_MODE") || "test").toLowerCase();
export const PAYSTACK_BASE_URL = "https://api.paystack.co";

export const SEND_CONFIRMATION_URL = `${SUPABASE_URL}/functions/v1/send-confirmation`;
export const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;

// ── CORS ──────────────────────────────────────────────────────────────────

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-paystack-signature, x-webhook-secret",
};

// ── Alert helper ──────────────────────────────────────────────────────────
// Fire-and-forget alert to the alert-founder EF. Never throws.

export async function alertFounder(alertType: string, context: Record<string, unknown>) {
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
// Fires once at cold start if DUFFEL_MODE or PAYSTACK_MODE doesn't match
// the key prefix. All requests refused with 503 + one CRITICAL alert per
// cold start.

let MODE_KEY_OK = true;
let MODE_KEY_REASON = "";
{
  const isDuffelTest = DUFFEL_API_KEY?.startsWith("duffel_test_");
  const isDuffelLive = DUFFEL_API_KEY?.startsWith("duffel_live_");
  const isPaystackTest = PAYSTACK_API_KEY?.startsWith("sk_test_");
  const isPaystackLive = PAYSTACK_API_KEY?.startsWith("sk_live_");

  if (!DUFFEL_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_API_KEY not set";
  } else if (!PAYSTACK_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_API_KEY not set";
  } else if (DUFFEL_MODE === "sandbox" && !isDuffelTest) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_MODE=sandbox but DUFFEL_API_KEY is not a test key";
  } else if (DUFFEL_MODE === "production" && !isDuffelLive) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_MODE=production but DUFFEL_API_KEY is not a live key";
  } else if (DUFFEL_MODE !== "sandbox" && DUFFEL_MODE !== "production") {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `DUFFEL_MODE has unexpected value: "${DUFFEL_MODE}"`;
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

export async function checkModeKeyMismatch(source: string): Promise<Response | null> {
  if (MODE_KEY_OK) return null;
  if (!modeKeyAlertFired) {
    modeKeyAlertFired = true;
    await alertFounder("PAYSTACK_OR_DUFFEL_MODE_KEY_MISMATCH", { source, reason: MODE_KEY_REASON });
  }
  return new Response(
    JSON.stringify({ error: "Service temporarily unavailable. Please try again shortly." }),
    { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

// ── Refund automation (Batch 2, Session 25) ──────────────────────────────
// Fires a Paystack refund when Duffel fails after we've captured payment
// (paid_offer_expired or paid_booking_failed). Idempotent: the
// refunds.paystack_tx_id unique index prevents double-refund attempts if
// the webhook re-fires or a retry job runs.
//
// Success path:
//   1. Insert refunds row (unique on tx_id — if already exists, we bail)
//   2. Call POST /refund with { transaction, currency: 'KES', merchant_note }
//   3. On 200: update refunds row with paystack_refund_id + status
//   4. Update pending_bookings.status → 'refund_pending'
//
// Failure path:
//   - Paystack refund API rejects → alert founder for manual intervention.
//     refunds row remains with paystack_refund_id=null so support can retry.

export async function refundBooking(
  supabase: any,
  reason: "paid_offer_expired" | "paid_booking_failed",
  pending: any,
  paystackTxId: string,
  reference: string,
): Promise<void> {
  try {
    // Step 1: idempotent insert. Unique index on paystack_tx_id makes
    // the DB the source of truth. Any race resolves here.
    const { error: insertErr } = await supabase.from("refunds").insert({
      pending_booking_id: pending.id,
      merchant_ref: reference,
      paystack_tx_id: paystackTxId,
      amount_kes: pending.total_kes,
      reason,
      status: "pending",
      customer_email: pending.contact?.email || null,
    });

    if (insertErr) {
      // Duplicate key = we've already tried this. Fine — bail cleanly.
      if (insertErr.code === "23505" || /duplicate/i.test(insertErr.message || "")) {
        console.log(`[refundBooking] Already exists for tx ${paystackTxId} (idempotent bail)`);
        return;
      }
      // Any other error is a real problem.
      console.error("[refundBooking] refunds insert failed:", insertErr);
      await alertFounder("REFUND_DB_INSERT_FAILED", {
        reason,
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        amount_kes: pending.total_kes,
        customer_email: pending.contact?.email,
        db_error: insertErr.message,
      });
      return;
    }

    // Step 2: fire Paystack refund
    const refundRes = await fetch(`${PAYSTACK_BASE_URL}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: paystackTxId,
        currency: "KES",
        // amount omitted → full refund of the captured amount
        merchant_note: `TumaFly system failure: ${reason} — ref ${reference}`,
      }),
    });
    const refundData = await refundRes.json();

    if (!refundRes.ok || !refundData?.status) {
      // Paystack said no. Row stays with paystack_refund_id=null and
      // status=pending. Support handles manually. Alert founder.
      console.error("[refundBooking] Paystack /refund non-2xx:", refundRes.status, refundData);
      await supabase
        .from("refunds")
        .update({ paystack_error: refundData })
        .eq("paystack_tx_id", paystackTxId);
      await alertFounder("REFUND_API_FAILED", {
        reason,
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        amount_kes: pending.total_kes,
        customer_email: pending.contact?.email,
        http_status: refundRes.status,
        paystack_error: refundData,
      });
      return;
    }

    // Step 3: update refunds row with Paystack's refund id + returned status
    const refundId = String(refundData?.data?.id || "");
    const returnedStatus = String(refundData?.data?.status || "pending");
    await supabase
      .from("refunds")
      .update({
        paystack_refund_id: refundId,
        status: returnedStatus,
      })
      .eq("paystack_tx_id", paystackTxId);

    // Step 4: pending_booking → refund_pending
    await supabase
      .from("pending_bookings")
      .update({ status: "refund_pending" })
      .eq("id", pending.id);

    console.log(`[refundBooking] Refund initiated: refund_id=${refundId} tx=${paystackTxId} ref=${reference}`);
  } catch (err) {
    console.error("[refundBooking] Unhandled:", err);
    await alertFounder("REFUND_UNHANDLED_ERROR", {
      reason,
      merchant_ref: reference,
      paystack_tx_id: paystackTxId,
      error: (err as Error).message,
    });
  }
}
