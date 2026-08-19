// ============================================================================
// paystack-webhook — Paystack IPN handler
// ============================================================================
// Receives Paystack's server-to-server events (HMAC-SHA512-verified). Handles:
//   - charge.success  — payment captured; advance pending_booking to 'paid',
//                       claim to 'duffel_pending', hand off to process-duffel-booking
//   - refund.pending  — refund accepted for processing; advance to 'refund_pending'
//   - refund.processed — refund settled; advance to 'refunded'
//   - refund.failed   — refund rejected; alert founder + mark 'refund_failed'
//
// Preserves:
//   - Duffel mode/key mismatch guard + alertFounder pattern
//   - Idempotency: bail on status='booked' or status='booking'
//   - Amount sanity check
//   - Atomic paid→booking claim (exactly one worker proceeds to Duffel)
//   - Duffel /air/orders with seat + baggage services (sandbox soft-skip)
//   - Full bookings row insert with itinerary details, tickets, seat maps
//   - EdgeRuntime.waitUntil(sendEmailPromise) for confirmation email
//   - Alert catalog integration (PAID_NO_OFFER, PAID_NO_TICKET, BOOKED_NO_DB_RECORD, etc.)
//
// Paystack specifics:
//   - HMAC-SHA512 signature verification of raw body
//   - Event parsing: charge.success from JSON body (not query params)
//   - Reference lookup: data.reference == our merchant_ref
//   - Amount in kobo/cents (KES × 100)
//   - Paystack verify endpoint call as belt-and-braces
//   - Response: plain 200 OK (Paystack retries on non-2xx)
//
// Paystack webhook URL to register in dashboard:
//   https://{PROJECT_REF}.supabase.co/functions/v1/paystack-webhook
//
// Events consumed (register ALL of these in Paystack dashboard, test AND live):
//   - charge.success            — capture completed
//   - refund.pending            — refund accepted for processing
//   - refund.processed          — refund settled (final state)
//   - refund.failed             — refund rejected (final state)
//
// Session 28e-10.7: pending_bookings columns renamed
//   pesapal_order_id → merchant_ref
//   pesapal_tracking_id → processor_transaction_id
// (Paystack authorization_code is written to bookings.processor_authorization_code
// by process-duffel-booking — see that EF.)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared helpers extracted in Session 28b commit #7b-i.
import {
  DUFFEL_WRITE_KEY, DUFFEL_BASE_URL, DUFFEL_MODE,
  SUPABASE_URL, SERVICE_ROLE_KEY,
  PAYSTACK_API_KEY, PAYSTACK_BASE_URL,
  CORS_HEADERS,
  alertFounder,
  checkModeKeyMismatch,
  refundBooking,
} from "../_shared/duffel-helpers.ts";

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
// the canonical values our DB uses. For card channels, prefers the specific
// brand from authorization.card_type ("visa", "mastercard", "amex", etc.)
// so my-trips can render "Visa ****1234" rather than a generic "Card ****1234".
// Falls back to "card" if brand can't be determined.
function normalizePaystackChannel(
  channel: string | null | undefined,
  authorization?: any,
): string {
  if (!channel) return "unknown";
  const c = String(channel).toLowerCase();
  if (c === "card") {
    // Paystack authorization.card_type values: "visa" | "mastercard" |
    // "verve" | "amex" | "discover" (plus rarer variants). We store the
    // brand lowercased; frontend title-cases for display.
    const brand = authorization?.card_type;
    if (typeof brand === "string" && brand.length > 0) {
      return brand.toLowerCase();
    }
    return "card";
  }
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

// ── Dispute event handler (S-06) ─────────────────────────────────────────
// Handles charge.dispute.create / .remind / .resolve events from Paystack.
// Lookup: merchant_ref (echoed on data.transaction.reference) → pending_bookings
// → booking_id → bookings. State transitions gated on prior_status per Rule 1;
// alert context always carries flown boolean per Rule 2. Rule 3 (customer-facing
// UX) is honored downstream by the frontend rendering on booking.status alone —
// nothing customer-facing changes as a result of these alerts.
async function handleDisputeEvent(eventType: string, event: any, supabase: any): Promise<Response> {
  const data = event?.data || {};

  // Paystack sends transaction as either an object (with .reference/.id) or as an id.
  // Mirror the pattern used in handleRefundEvent.
  const reference =
    (typeof data.transaction === "object" && data.transaction ? data.transaction.reference : null) ||
    data.reference ||
    "";
  const paystackTxId = String(
    (typeof data.transaction === "object" && data.transaction ? data.transaction.id : data.transaction) || ""
  );
  const disputeCode = data.id ? String(data.id) : "";
  const disputeReason = data.reason || "";
  const resolution = data.resolution || "";

  if (!reference) {
    console.error(`[handleDisputeEvent] ${eventType} with no reference`);
    await alertFounder("UNHANDLED_ERROR", {
      message: `Dispute event ${eventType} received with no transaction reference`,
      event_type: eventType,
      dispute_code: disputeCode,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Look up via pending_bookings.merchant_ref → booking_id
  const { data: pending, error: pendingErr } = await supabase
    .from("pending_bookings")
    .select("id, booking_id, merchant_ref")
    .eq("merchant_ref", reference)
    .maybeSingle();

  const isRemind = eventType === "charge.dispute.remind";
  const isResolve = eventType === "charge.dispute.resolve";
  const openedOrRemindAlert = isRemind ? "CHARGEBACK_REMINDER" : "CHARGEBACK_OPENED";

  if (pendingErr || !pending) {
    // No pending_booking for this reference — dispute against something we don't
    // track. Still alert; support reconciles by hand.
    console.error(`[handleDisputeEvent] No pending_booking for reference ${reference}`);
    await alertFounder(isResolve ? "CHARGEBACK_RESOLVED_LOST" : openedOrRemindAlert, {
      event_type: eventType,
      reference,
      paystack_tx_id: paystackTxId,
      dispute_code: disputeCode,
      dispute_reason: disputeReason,
      message: "No matching pending_booking found — dispute cannot be linked to a booking",
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  if (!pending.booking_id) {
    // Dispute on a payment that never became a full booking (e.g. paid_booking_failed
    // where we kept the service fee). Alert only — no bookings row to transition.
    await alertFounder(isResolve ? "CHARGEBACK_RESOLVED_LOST" : openedOrRemindAlert, {
      event_type: eventType,
      merchant_ref: reference,
      pending_booking_id: pending.id,
      paystack_tx_id: paystackTxId,
      dispute_code: disputeCode,
      dispute_reason: disputeReason,
      message: "Dispute for a pending_booking that never became a full booking (e.g. paid_booking_failed retained service fee)",
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Full booking lookup
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, booking_reference, status, slices")
    .eq("id", pending.booking_id)
    .maybeSingle();

  if (bookingErr || !booking) {
    await alertFounder("UNHANDLED_ERROR", {
      message: "handleDisputeEvent could not fetch booking row",
      event_type: eventType,
      pending_booking_id: pending.id,
      booking_id: pending.booking_id,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Rule 2 — compute flown boolean from last-slice arriving_at with fallbacks.
  // If schema shape changes and none of the paths work, flown stays false (safe).
  let flown = false;
  try {
    const slices = Array.isArray(booking.slices) ? booking.slices : [];
    if (slices.length > 0) {
      const lastSlice = slices[slices.length - 1];
      const segments = Array.isArray(lastSlice?.segments) ? lastSlice.segments : [];
      const lastSegment = segments[segments.length - 1];
      const flightEndTs =
        lastSegment?.arriving_at ||
        lastSlice?.arriving_at ||
        lastSegment?.departing_at ||
        lastSlice?.departing_at ||
        null;
      if (flightEndTs) {
        flown = new Date(flightEndTs).getTime() < Date.now();
      }
    }
  } catch (_) { /* flown stays false */ }

  const priorStatus = booking.status;

  // ── Route by event type ──
  if (eventType === "charge.dispute.create") {
    // Rule 1: transition only from 'confirmed'. Pre-existing cancel states preserved.
    if (priorStatus === "confirmed") {
      await supabase.from("bookings").update({ status: "disputed" }).eq("id", booking.id);
    }
    await alertFounder("CHARGEBACK_OPENED", {
      event_type: eventType,
      merchant_ref: reference,
      booking_reference: booking.booking_reference,
      booking_id: booking.id,
      paystack_tx_id: paystackTxId,
      dispute_code: disputeCode,
      dispute_reason: disputeReason,
      prior_status: priorStatus,
      flown,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  if (isRemind) {
    // No state change — reminders don't move state.
    await alertFounder("CHARGEBACK_REMINDER", {
      event_type: eventType,
      merchant_ref: reference,
      booking_reference: booking.booking_reference,
      booking_id: booking.id,
      paystack_tx_id: paystackTxId,
      dispute_code: disputeCode,
      dispute_reason: disputeReason,
      prior_status: priorStatus,
      flown,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  if (isResolve) {
    // Paystack resolution values are inconsistent across docs/versions. Conservative:
    // treat these as WON: 'won', 'merchant-won', 'resolved-merchant'. Anything else
    // (including empty, 'merchant-accepted', 'declined') → LOST. Raw resolution
    // string is passed through in the alert so operators can spot mis-parse.
    const wonResolution = /^(won|merchant-won|resolved-merchant)$/i.test(resolution);
    const outcome = wonResolution ? "won" : "lost";
    const alertType = wonResolution ? "CHARGEBACK_RESOLVED_WON" : "CHARGEBACK_RESOLVED_LOST";

    // Rule 1: transition only from 'disputed' (i.e., we moved it on create).
    // Pre-existing cancel states preserved.
    if (priorStatus === "disputed") {
      const newStatus = wonResolution ? "chargeback_won" : "chargeback_lost";
      await supabase.from("bookings").update({ status: newStatus }).eq("id", booking.id);
    }

    await alertFounder(alertType, {
      event_type: eventType,
      merchant_ref: reference,
      booking_reference: booking.booking_reference,
      booking_id: booking.id,
      paystack_tx_id: paystackTxId,
      dispute_code: disputeCode,
      dispute_reason: disputeReason,
      dispute_outcome: outcome,
      prior_status: priorStatus,
      flown,
      reason: resolution || "(paystack sent no resolution string)",
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Unknown dispute event subtype (future Paystack additions)
  console.log(`[handleDisputeEvent] Unknown dispute event: ${eventType}`);
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
  //   - charge.success                          → book with Duffel + save booking
  //   - refund.pending/processed/failed         → update refunds table + cascade
  //   - charge.dispute.create/remind/resolve    → S-06 handleDisputeEvent (alert + gated state transition)
  // Others (transfer.*, subscription.*, etc.) get 200 OK.
  const eventType = event?.event || "";

  // Refund events go to the dedicated handler.
  if (eventType === "refund.pending" || eventType === "refund.processed" || eventType === "refund.failed") {
    return await handleRefundEvent(eventType, event, supabase);
  }

  // S-06: Dispute events go to the dedicated handler.
  if (eventType === "charge.dispute.create" || eventType === "charge.dispute.remind" || eventType === "charge.dispute.resolve") {
    return await handleDisputeEvent(eventType, event, supabase);
  }

  if (eventType !== "charge.success") {
    console.log(`[paystack-webhook] Ignoring event type: ${eventType}`);
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const data = event.data || {};
  const reference = data.reference || "";
  const paystackTxId = String(data.id || "");
  const channel = normalizePaystackChannel(data.channel, data.authorization);
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
    // 1. Find pending booking by merchant_ref (Paystack echoes it back as data.reference).
    const { data: pending, error: pendingErr } = await supabase
      .from("pending_bookings")
      .select("*")
      .eq("merchant_ref", reference)
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

    // 2. Idempotency — 'pending' is the only valid entry state. Any other
        //    value means this webhook has already fired for this row, or a
        //    downstream EF (process-duffel-booking, refundBooking, refund event
        //    handler) has moved the state forward. Post-#6, forward states
        //    include: paid, duffel_pending, pnr_issued, booked, refund_pending,
        //    refunded, paid_offer_expired, paid_booking_failed, failed_to_create,
        //    payment_invalid, amount_mismatch. Bail on all of them so we never
        //    regress a moved-forward row back to 'paid' via step 5's UPDATE.
        if (pending.status !== "pending") {
          console.log(`Webhook re-fired for ${pending.status} booking (${reference}) — idempotency bail`);
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
      console.error("[paystack-webhook] Verify endpoint disagrees with webhook");
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
        processor_transaction_id: paystackTxId,
      })
      .eq("id", pending.id);

    // 5b. Atomic claim — exactly one worker proceeds to Duffel.
    const { data: claimed, error: claimErr } = await supabase
      .from("pending_bookings")
      .update({ status: "duffel_pending" })
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
        Authorization: `Bearer ${DUFFEL_WRITE_KEY}`,
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

    // 7. Offer confirmed live. paystack-webhook's job is done —
    // process-duffel-booking (triggered by DB webhook on the
    // paid → duffel_pending transition above) does the actual
    // POST /air/orders. Return 200 so Paystack does not retry.
    console.log(`[${reference}] Offer live; handed off to process-duffel-booking via duffel_pending state.`);
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