// ============================================================================
// paystack-webhook — Paystack IPN handler
// ============================================================================
// Mirrors pesapal-webhook line-by-line. Preserves:
//   - Duffel mode/key mismatch guard + alertFounder pattern
//   - Idempotency: bail on status='booked' or status='booking'
//   - Amount sanity check
//   - Atomic paid→booking claim (exactly one worker proceeds to Duffel)
//   - Duffel /air/orders with seat + baggage services (sandbox soft-skip)
//   - Full bookings row insert with itinerary details, tickets, seat maps
//   - EdgeRuntime.waitUntil(sendEmailPromise) for confirmation email
//   - Alert catalog integration (PAID_NO_OFFER, PAID_NO_TICKET, BOOKED_NO_DB_RECORD, etc.)
//
// Processor-specific bits swapped:
//   - HMAC-SHA512 signature verification of raw body (Paystack pattern)
//   - Event parsing: charge.success from JSON body (not query params)
//   - Reference lookup: data.reference == our merchant_ref (stored in pesapal_order_id column)
//   - Amount in kobo/cents (KES × 100)
//   - Paystack verify endpoint call as belt-and-braces
//   - Response: plain 200 OK (Paystack retries on non-2xx)
//
// Column reuse notes:
//   - pesapal_order_id: stores merchant_ref for BOTH processors (rename in future migration)
//   - pesapal_tracking_id: stores Paystack transaction id (data.id) for Paystack rows
//   - pesapal_confirmation_code: stores Paystack authorization_code (card token for
//     future recurring/tokenization) for Paystack rows
//
// Paystack webhook URL to register in dashboard:
//   https://{PROJECT_REF}.supabase.co/functions/v1/paystack-webhook
//
// Events consumed (register ALL of these in Paystack dashboard, test AND live):
//   - charge.success            — capture completed
//   - refund.pending            — refund accepted for processing
//   - refund.processed          — refund settled (final state)
//   - refund.failed             — refund rejected (final state)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY")!;
const DUFFEL_BASE_URL = "https://api.duffel.com";
const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const PAYSTACK_API_KEY = Deno.env.get("PAYSTACK_API_KEY")!;
const PAYSTACK_MODE = (Deno.env.get("PAYSTACK_MODE") || "test").toLowerCase();
const PAYSTACK_BASE_URL = "https://api.paystack.co";

const SEND_CONFIRMATION_URL = `${SUPABASE_URL}/functions/v1/send-confirmation`;
const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-paystack-signature",
};

// Fire-and-forget alert helper (identical to pesapal-webhook)
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
// Fires once at cold start if DUFFEL_MODE or PAYSTACK_MODE doesn't match the
// key prefix. All requests refused with 503 + one CRITICAL alert per cold start.
let MODE_KEY_OK = true;
let MODE_KEY_REASON = "";
{
  const isDuffelTest = DUFFEL_API_KEY.startsWith("duffel_test_");
  const isDuffelLive = DUFFEL_API_KEY.startsWith("duffel_live_");
  const isPaystackTest = PAYSTACK_API_KEY.startsWith("sk_test_");
  const isPaystackLive = PAYSTACK_API_KEY.startsWith("sk_live_");

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

async function checkModeKeyMismatch(source: string): Promise<Response | null> {
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

// ── Signature verification ────────────────────────────────────────────────
// Paystack signs webhooks with HMAC-SHA512, using YOUR SECRET KEY as the HMAC
// key, computed over the raw request body (byte-exact — no JSON re-serialization).
// Signature is sent in the `x-paystack-signature` header as lowercase hex.
//
// Constant-time comparison to prevent timing attacks (though the response
// time here is dominated by the Duffel call, not the signature check).
//
// This function returns false on ANY error path (no key, no signature, no body,
// mismatch, exception) — fail-closed for a webhook that grants real bookings.
async function verifyPaystackSignature(rawBody: string, signature: string, secretKey: string): Promise<boolean> {
  if (!signature || !rawBody || !secretKey) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secretKey),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const hexSig = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hexSig.length !== signature.length) return false;
    // Constant-time comparison
    let result = 0;
    for (let i = 0; i < hexSig.length; i++) {
      result |= hexSig.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
  } catch (e) {
    console.error("[paystack-webhook] Signature verification threw:", e);
    return false;
  }
}

// Small helper: normalize payment_method from Paystack's channel string to
// match what we stored for Pesapal ("card", "mobile_money", "bank", etc.)
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

// Extract last-4 digits from a Paystack authorization block (card only).
// M-Pesa / mobile-money charges don't have a card number; return null.
function extractLast4FromAuth(authorization: any): string | null {
  if (!authorization || typeof authorization !== "object") return null;
  const last4 = authorization.last4;
  if (typeof last4 === "string" && last4.length === 4) return last4;
  return null;
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
async function refundBooking(
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

// ── Refund event handler (Batch 2, Session 25) ───────────────────────────
// Handles refund.pending / refund.processed / refund.failed events from
// Paystack. Lookup goes through refunds.paystack_refund_id (set once we've
// issued the refund) with fallback to paystack_tx_id.
async function handleRefundEvent(eventType: string, event: any, supabase: any): Promise<Response> {
  const data = event.data || {};
  const refundId = String(data.id || "");
  // Paystack sends `transaction` as either an object (with .id) or as an id directly.
  const txId = typeof data.transaction === "object" && data.transaction
    ? String(data.transaction.id || data.transaction.reference || "")
    : String(data.transaction || "");
  const status = eventType.split(".")[1] || String(data.status || "unknown"); // 'processed' | 'failed' | 'pending'

  if (!refundId && !txId) {
    console.error("[handleRefundEvent] No id or transaction in payload");
    await alertFounder("REFUND_EVENT_MISSING_IDS", { event_type: eventType, payload: data });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Find the refunds row. Prefer paystack_refund_id, fall back to paystack_tx_id.
  let row: any = null;
  if (refundId) {
    const { data: r } = await supabase
      .from("refunds")
      .select("*")
      .eq("paystack_refund_id", refundId)
      .maybeSingle();
    row = r;
  }
  if (!row && txId) {
    const { data: r } = await supabase
      .from("refunds")
      .select("*")
      .eq("paystack_tx_id", txId)
      .maybeSingle();
    row = r;
  }

  if (!row) {
    // Refund initiated outside our system (Paystack dashboard) — no matching row.
    // Alert so support can reconcile manually. Don't block the event.
    console.warn(`[handleRefundEvent] No matching refund row: refund_id=${refundId} tx_id=${txId}`);
    await alertFounder("REFUND_EVENT_NO_ROW", {
      event_type: eventType,
      paystack_refund_id: refundId,
      paystack_tx_id: txId,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Update refunds row
  await supabase
    .from("refunds")
    .update({
      status,
      paystack_refund_id: refundId || row.paystack_refund_id,
    })
    .eq("id", row.id);

  // Cascade to pending_bookings
  if (status === "processed") {
    await supabase
      .from("pending_bookings")
      .update({ status: "refunded" })
      .eq("id", row.pending_booking_id);
    console.log(`[handleRefundEvent] refund.processed — pending_booking ${row.pending_booking_id} → refunded`);
  } else if (status === "failed") {
    // Leave pending_booking as refund_pending so support has a triage signal.
    await alertFounder("REFUND_FAILED", {
      merchant_ref: row.merchant_ref,
      paystack_tx_id: row.paystack_tx_id,
      paystack_refund_id: refundId || row.paystack_refund_id,
      amount_kes: row.amount_kes,
      customer_email: row.customer_email,
      reason: row.reason,
    });
  }
  // status === 'pending' — no cascade needed; already refund_pending.

  return new Response("ok", { status: 200, headers: CORS_HEADERS });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // GUARD: refuse if DUFFEL_MODE / PAYSTACK_MODE disagree with key prefixes.
  const guardBlock = await checkModeKeyMismatch("paystack-webhook");
  if (guardBlock) return guardBlock;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Read raw body FIRST (needed for signature verification) ─────────────
  // Do NOT JSON.parse then re-stringify — Paystack signs the exact bytes we
  // received, and any whitespace/ordering difference will fail verification.
  let rawBody = "";
  let event: any = null;
  try {
    rawBody = await req.text();
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error("[paystack-webhook] Invalid JSON body:", err);
    // Return 200 so Paystack doesn't retry a malformed payload forever.
    // Alert so we know something upstream sent garbage.
    await alertFounder("PAYSTACK_MALFORMED_WEBHOOK", {
      error: (err as Error).message,
      body_length: rawBody.length,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // ── Verify signature ────────────────────────────────────────────────────
  const signature = req.headers.get("x-paystack-signature") || "";
  const validSig = await verifyPaystackSignature(rawBody, signature, PAYSTACK_API_KEY);
  if (!validSig) {
    console.error("[paystack-webhook] Signature verification failed");
    await alertFounder("PAYSTACK_SIGNATURE_FAILURE", {
      event_type: event?.event || "unknown",
      reference: event?.data?.reference || "unknown",
      signature_header_present: !!signature,
      reason: "HMAC-SHA512 mismatch",
    });
    // 401 signals a bad actor — Paystack won't retry (which we want here,
    // since the payload is untrusted).
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // ── Event routing ──────────────────────────────────────────────────────
  // Paystack sends many event types. We act on:
  //   - charge.success                   → book with Duffel + save booking
  //   - refund.pending/processed/failed  → update refunds table + cascade
  // Others (charge.dispute.*, transfer.*, subscription.*, etc.) get 200 OK.
  const eventType = event?.event || "";

  // Refund events go to the dedicated handler.
  if (eventType === "refund.pending" || eventType === "refund.processed" || eventType === "refund.failed") {
    return await handleRefundEvent(eventType, event, supabase);
  }

  if (eventType !== "charge.success") {
    console.log(`[paystack-webhook] Ignoring event type: ${eventType}`);
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const data = event.data || {};
  const reference = data.reference || "";
  const paystackTxId = String(data.id || "");
  const channel = normalizePaystackChannel(data.channel);
  const paystackAmountKobo = Number(data.amount) || 0;
  const paidAmountKes = paystackAmountKobo / 100;

  if (!reference) {
    console.error("[paystack-webhook] charge.success with no reference");
    await alertFounder("PAYSTACK_MISSING_REFERENCE", {
      event_type: eventType,
      paystack_tx_id: paystackTxId,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  try {
    // 1. Find pending booking. merchant_ref is stored in pesapal_order_id
    //    column (both processors reuse it — rename in future migration).
    const { data: pending, error: pendingErr } = await supabase
      .from("pending_bookings")
      .select("*")
      .eq("pesapal_order_id", reference)
      .maybeSingle();

    if (pendingErr || !pending) {
      console.error("CRITICAL: Webhook for unknown reference:", reference);
      await alertFounder("UNHANDLED_ERROR", {
        message: "Paystack webhook fired for unknown reference",
        reference,
        paystack_tx_id: paystackTxId,
      });
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // 2. Idempotency — already booked OR another worker is mid-booking.
    if (pending.status === "booked" || pending.status === "booking") {
      console.log(`Webhook re-fired for ${pending.status} booking (${reference})`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // 3. Belt-and-braces: verify with Paystack directly, in case the webhook
    //    was replayed with a modified body that somehow passed signature
    //    check (defensive; shouldn't happen with HMAC-SHA512). This also
    //    surfaces any discrepancy between Paystack's stored state and the
    //    event payload.
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

    if (!verifyRes.ok || !verifyData?.status || verifyData?.data?.status !== "success") {
      console.error("[paystack-webhook] Verify endpoint disagrees with webhook:", verifyData);
      await supabase
        .from("pending_bookings")
        .update({ status: "payment_invalid", payment_method: channel })
        .eq("id", pending.id);

      await alertFounder("PAYMENT_FAILED", {
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        verify_status: verifyData?.data?.status || "unknown",
        verify_gateway_response: verifyData?.data?.gateway_response || null,
        customer_email: pending.contact.email,
      });

      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // 4. Amount sanity check. Paystack's authoritative amount comes from
    //    verifyData.data.amount (also in kobo). Cross-check both.
    const verifiedAmountKes = (Number(verifyData.data.amount) || 0) / 100;
    if (Math.abs(verifiedAmountKes - pending.total_kes) > 1) {
      await supabase
        .from("pending_bookings")
        .update({ status: "amount_mismatch", payment_method: channel })
        .eq("id", pending.id);

      await alertFounder("AMOUNT_MISMATCH", {
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        expected_kes: pending.total_kes,
        received_kes: verifiedAmountKes,
        webhook_amount_kes: paidAmountKes,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
      });

      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // 5. Mark as paid (logical milestone — payment is confirmed).
    await supabase
      .from("pending_bookings")
      .update({
        status: "paid",
        payment_method: channel,
        pesapal_tracking_id: paystackTxId, // reused column — stores Paystack tx id
      })
      .eq("id", pending.id);

    // 5b. Atomic claim — exactly one worker proceeds to Duffel.
    const { data: claimed, error: claimErr } = await supabase
      .from("pending_bookings")
      .update({ status: "booking" })
      .eq("id", pending.id)
      .eq("status", "paid")
      .select();

    if (claimErr) {
      console.error("Atomic claim error:", claimErr);
      // Transient — return non-2xx so Paystack retries.
      return new Response(JSON.stringify({ error: "Transient DB error" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (!claimed || claimed.length === 0) {
      // Another worker won the race — they're finalizing.
      console.log(`Booking already claimed by another worker for ${pending.id}`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    // 6. Re-fetch Duffel offer (may have expired during payment)
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
      // Payment captured but Duffel offer is gone. Alert + auto-refund.
      await supabase
        .from("pending_bookings")
        .update({ status: "paid_offer_expired" })
        .eq("id", pending.id);

      await alertFounder("PAID_NO_OFFER", {
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
        passengers: pending.passengers,
        duffel_error: offerData,
      });

      // Auto-refund — updates status to refund_pending on success.
      await refundBooking(supabase, "paid_offer_expired", pending, paystackTxId, reference);

      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    const offer = offerData.data;

    // 7. Book with Duffel — identical construction to pesapal-webhook
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

    // 7a. Build services from stashed seat + baggage selections. Sandbox
    // soft-skip identical to pesapal-webhook.
    const storedSeats: any[] = Array.isArray(pending.contact?.seats) ? pending.contact.seats : [];
    const storedBaggages: any[] = Array.isArray(pending.contact?.baggages) ? pending.contact.baggages : [];
    const services: Array<{ id: string; quantity: number; passenger_id: string }> = [];
    let extrasAmountInOfferCurrency = 0;
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
          extrasAmountInOfferCurrency += parseFloat(seat.original_amount);
        }
      }
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
    const orderRespData = await orderRes.json();

    if (!orderRes.ok) {
      // Payment captured, Duffel order create rejected. Alert + auto-refund.
      await supabase
        .from("pending_bookings")
        .update({ status: "paid_booking_failed" })
        .eq("id", pending.id);

      await alertFounder("PAID_NO_TICKET", {
        merchant_ref: reference,
        paystack_tx_id: paystackTxId,
        duffel_offer_id: pending.duffel_offer_id,
        amount_paid_kes: pending.total_kes,
        customer_email: pending.contact.email,
        customer_phone: pending.contact.phone_number,
        passengers: pending.passengers,
        seat_selections: storedSeats,
        baggage_selections: storedBaggages,
        duffel_error: orderRespData,
      });

      // Auto-refund — updates status to refund_pending on success.
      await refundBooking(supabase, "paid_booking_failed", pending, paystackTxId, reference);

      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    const order = orderRespData.data;
    const outbound = order.slices[0];
    const outboundSeg = outbound.segments[0];
    const returnSlice = order.slices[1] || null;
    const returnSeg = returnSlice ? returnSlice.segments[0] : null;

    // ── Derive itinerary-detail fields (identical to pesapal-webhook) ────
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
    const seatsSelected = Array.isArray(pending.contact?.seats) && pending.contact.seats.length > 0;
    const changesAllowed = offer?.conditions?.change_before_departure?.allowed ?? null;

    const storedSeatsByPaxAndSeg: Record<string, string> = {};
    for (const s of (pending.contact?.seats || [])) {
      const key = `${s.passenger_index}::${s.segment_id || ''}`;
      if (s.designator) storedSeatsByPaxAndSeg[key] = s.designator;
    }

    const electronicTickets = (order.documents || [])
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
            && Array.isArray(s.segment_ids)   && s.segment_ids.includes(seg.id)
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

    // 8. Save booking
    // Column reuse notes:
    //   - pesapal_tracking_id: stores Paystack transaction id (data.id)
    //   - pesapal_confirmation_code: stores Paystack authorization_code
    //     (card token for potential future recurring / one-tap re-charge)
    const authorizationCode = data.authorization?.authorization_code || null;
    const cardLast4 = extractLast4FromAuth(data.authorization);
    const mpesaMobile = channel === "mpesa"
      ? (data.customer?.phone || data.authorization?.mobile_money?.phone || null)
      : null;
    // Match Pesapal's payment_account_last4 semantics:
    //   - cards: last 4 digits of card
    //   - M-Pesa: last 4 digits of phone number
    const paymentAccountLast4 = cardLast4 || ((phone: string | null) => {
      if (!phone) return null;
      const digits = String(phone).replace(/\D/g, "");
      return digits.length >= 4 ? digits.slice(-4) : null;
    })(mpesaMobile);

    const { error: dbErr } = await supabase.from("bookings").insert({
      user_id: pending.user_id || null,
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
      payment_method: channel,
      payment_account_last4: paymentAccountLast4,
      pesapal_tracking_id: paystackTxId,                  // reused column
      pesapal_confirmation_code: authorizationCode,        // reused column
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

    // 10. Send confirmation eTicket email via EdgeRuntime.waitUntil
    //     (identical to pesapal-webhook)
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

    const sendEmailPromise = fetch(SEND_CONFIRMATION_URL, {
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
    }).catch(err => console.error("Email send failed (non-blocking):", err));

    // @ts-ignore — EdgeRuntime is the Supabase Edge Runtime global
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(sendEmailPromise);
    } else {
      await sendEmailPromise;
    }

    return new Response("ok", { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    console.error("CRITICAL: webhook unhandled error", err);
    await alertFounder("UNHANDLED_ERROR", {
      reference,
      paystack_tx_id: paystackTxId,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    // Non-2xx so Paystack retries. Our idempotency guard catches re-fires.
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});