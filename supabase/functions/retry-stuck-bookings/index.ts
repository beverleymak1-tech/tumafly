// ============================================================================
// retry-stuck-bookings — v2 (Session 28b commit #9)
// ============================================================================
// State-transition reconciler. Not a booking-creator. Runs every minute via
// pg_cron (job id 1, schedule '* * * * *').
//
// Six sweep buckets (age-based, per-state):
//
//   paid > 60s
//     Nudge: compare-and-set to duffel_pending. DB webhook fires
//     process-duffel-booking. Catches paystack-webhook crashes between SET
//     paid and the atomic claim to duffel_pending (narrow window post-#6
//     but real).
//
//   duffel_pending 60s - 5min
//     Nudge: HTTP POST to process-duffel-booking with the DB-webhook payload
//     shape. Idempotent — Duffel-Idempotency-Key means retries return the
//     existing order rather than creating a duplicate. No code duplication:
//     the primary booking path handles all six response branches.
//
//   duffel_pending > 5min
//     Force-fail with orphan check. GET /air/orders?duffel_idempotency_key=<id>
//       - Duffel HAS the order → CRITICAL alert. Row stays at duffel_pending
//         until manual reconciliation. (Duffel has it, we can't complete
//         cleanly — usually indicates a bug in process-duffel-booking or
//         send-confirmation. Don't refund a booked customer.)
//       - Duffel doesn't have it → transition paid_booking_failed, refund.
//
//   pnr_issued > 60s
//     Poll ticket issuance: GET /air/orders/<duffel_order_id>
//       - documents[] populated → transition to booked, fire send-confirmation
//         with confirmation_email_sent_at atomic guard
//       - documents[] empty → leave for next sweep (until 15min force-fail)
//
//   pnr_issued > 15min
//     Force-fail: cancel Duffel order (POST /air/orders/<id>/actions/cancel
//     — avoids airline billing us for a ticket we didn't deliver), transition
//     paid_booking_failed, fire refundBooking.
//
//   booked with NULL confirmation_email_sent_at > 60s
//     Re-fire send-confirmation with atomic guard. Third fire site per
//     handoff §4.3 (sync happy-path in #7b-ii; async in #8's order.created
//     webhook; polled here in #9).
//
// Removed from v1:
//   - Direct Duffel POST /air/orders. Replaced with nudge to
//     process-duffel-booking (single canonical booking path).
//   - Legacy 'booking' state sweep. State deprecated per Master Edit 8 Q5.
//   - 'paid_booking_orphan' branch. Impossible post-Idempotency-Key.
//   - Broken send-confirmation body shape. Canonical is
//     { to, order, pending, breakdown_kes }.
//
// Auth: service_role via Authorization header (pg_cron passes it via Vault
// secret). Same pattern as v1.
//
// Batch sizing: up to 5 rows per state per invocation (max 20 total).
// Cron every minute → 300/hr per state ceiling. Well above real recovery
// throughput.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  DUFFEL_API_KEY, DUFFEL_BASE_URL,
  SUPABASE_URL, SERVICE_ROLE_KEY,
  SEND_CONFIRMATION_URL,
  CORS_HEADERS,
  alertFounder,
  checkModeKeyMismatch,
  refundBooking,
} from "../_shared/duffel-helpers.ts";

const PROCESS_DUFFEL_BOOKING_URL = `${SUPABASE_URL}/functions/v1/process-duffel-booking`;
const PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET =
  Deno.env.get("PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET") || "";

// Age thresholds (seconds). Small on paid (webhook stall = fast catch).
// Wider on Duffel-side states (give Duffel breathing room for their own
// async ticketing on production carriers).
const AGE_PAID_STUCK_S           = 60;
const AGE_DUFFEL_PENDING_NUDGE_S = 60;
const AGE_DUFFEL_PENDING_FAIL_S  = 300;   // 5 min
const AGE_PNR_ISSUED_POLL_S      = 60;
const AGE_PNR_ISSUED_FAIL_S      = 900;   // 15 min
const AGE_BOOKED_NO_EMAIL_S      = 60;

const BATCH_LIMIT = 5; // per-state cap per invocation

const DUFFEL_HEADERS = {
  Authorization: `Bearer ${DUFFEL_API_KEY}`,
  "Duffel-Version": "v2",
  Accept: "application/json",
};

// ── Duffel helpers ────────────────────────────────────────────────────────
function documentsPopulated(order: any): boolean {
  const docs = Array.isArray(order?.documents) ? order.documents : [];
  return docs.some((d: any) =>
    (d?.type === "electronic_ticket" || d?.type === "ticket") && d?.unique_identifier
  );
}

// ── Send-confirmation caller with atomic idempotency guard ────────────────
// Used by pnr_issued → booked transition and by booked-no-email retry.
async function fireSendConfirmation(
  supabase: any,
  pending: any,
  order: any,
): Promise<{ ok: boolean; http_status?: number; body?: string; error?: string }> {
  const storedSeats: any[] = Array.isArray(pending.contact?.seats) ? pending.contact.seats : [];
  const storedBaggages: any[] = Array.isArray(pending.contact?.baggages) ? pending.contact.baggages : [];
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

  try {
    const emailRes = await fetch(SEND_CONFIRMATION_URL, {
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
    if (!emailRes.ok) {
      const body = await emailRes.text().catch(() => "");
      return { ok: false, http_status: emailRes.status, body: body.slice(0, 500) };
    }
    // Atomic guard: only stamp if not already stamped (race with #7b-ii and #8).
    await supabase
      .from("pending_bookings")
      .update({ confirmation_email_sent_at: new Date().toISOString() })
      .eq("id", pending.id)
      .is("confirmation_email_sent_at", null);
    return { ok: true, http_status: emailRes.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Bucket handlers ───────────────────────────────────────────────────────

// Bucket 1: paid > 60s
async function nudgePaidToDuffelPending(supabase: any, row: any): Promise<any> {
  const { data: claimed } = await supabase
    .from("pending_bookings")
    .update({ status: "duffel_pending" })
    .eq("id", row.id)
    .eq("status", "paid")
    .lte("updated_at", row.updated_at)
    .select();
  if (!claimed || claimed.length === 0) {
    return { outcome: "skipped_paid_no_longer_stuck" };
  }
  console.log(`[retry] paid → duffel_pending: ${row.pesapal_order_id}`);
  return { outcome: "nudged_paid_to_duffel_pending" };
}

// Bucket 2: duffel_pending 60s - 5min (nudge)
async function nudgeProcessDuffelBooking(row: any): Promise<any> {
  if (!PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET) {
    await alertFounder("UNHANDLED_ERROR", {
      function: "retry-stuck-bookings",
      merchant_ref: row.pesapal_order_id,
      message: "PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET not set — cannot nudge",
    });
    return { outcome: "config_error_no_secret" };
  }
  try {
    const nudgeRes = await fetch(PROCESS_DUFFEL_BOOKING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ record: { id: row.id } }),
    });
    console.log(`[retry] nudged process-duffel-booking for ${row.pesapal_order_id} → ${nudgeRes.status}`);
    return { outcome: "nudged_process_duffel_booking", http_status: nudgeRes.status };
  } catch (err) {
    return { outcome: "nudge_threw", error: (err as Error).message };
  }
}

// Bucket 3: duffel_pending > 5min (force-fail with orphan check)
async function forceFailDuffelPending(supabase: any, row: any): Promise<any> {
  // Orphan check: does Duffel have an order under our idempotency key?
  let orderExistsAtDuffel = false;
  let orderInspection: any = null;
  try {
    const listRes = await fetch(
      `${DUFFEL_BASE_URL}/air/orders?duffel_idempotency_key=${encodeURIComponent(row.id)}`,
      { headers: DUFFEL_HEADERS },
    );
    orderInspection = await listRes.json();
    if (listRes.ok && Array.isArray(orderInspection?.data) && orderInspection.data.length > 0) {
      orderExistsAtDuffel = true;
    }
  } catch (err) {
    console.warn(`[retry] Duffel GET (idempotency lookup) threw for ${row.pesapal_order_id}:`, err);
    // Fall through as if not found. Next sweep will retry.
  }

  if (orderExistsAtDuffel) {
    // Duffel has the order but process-duffel-booking never finished. Bug
    // territory. Alert loudly and LEAVE THE ROW at duffel_pending. Do NOT
    // refund a customer who actually got their booking created.
    await alertFounder("PAID_NO_TICKET", {
      severity: "CRITICAL",
      merchant_ref: row.pesapal_order_id,
      pending_booking_id: row.id,
      duffel_offer_id: row.duffel_offer_id,
      amount_paid_kes: row.total_kes,
      customer_email: row.contact?.email,
      customer_phone: row.contact?.phone_number,
      passengers: row.passengers,
      message: "duffel_pending stuck > 5min AND Duffel has an order under this idempotency key. process-duffel-booking or send-confirmation may have a bug. Manual reconciliation: check Duffel dashboard for the order, verify passenger details, run process-duffel-booking manually or complete the bookings INSERT + status transition by hand. Do NOT refund — customer's booking is created.",
      source: "retry-stuck-bookings",
      duffel_orphan_check: orderInspection,
    });
    return { outcome: "duffel_pending_orphan_alert_only" };
  }

  // Duffel doesn't have it. Refund + fail.
  const { data: claimed } = await supabase
    .from("pending_bookings")
    .update({ status: "paid_booking_failed" })
    .eq("id", row.id)
    .eq("status", "duffel_pending")
    .select();
  if (!claimed || claimed.length === 0) {
    return { outcome: "skipped_duffel_pending_transitioned" };
  }
  await alertFounder("PAID_NO_TICKET", {
    merchant_ref: row.pesapal_order_id,
    pending_booking_id: row.id,
    duffel_offer_id: row.duffel_offer_id,
    amount_paid_kes: row.total_kes,
    customer_email: row.contact?.email,
    customer_phone: row.contact?.phone_number,
    passengers: row.passengers,
    source: "retry-stuck-bookings",
    reason: "duffel_pending > 5min, no order at Duffel — force-failed",
  });
  await refundBooking(
    supabase,
    "paid_booking_failed",
    row,
    row.pesapal_tracking_id,
    row.pesapal_order_id,
  );
  return { outcome: "duffel_pending_force_failed_and_refund_initiated" };
}

// Bucket 4: pnr_issued 60s - 15min (poll for ticket issuance)
// Bucket 5: pnr_issued > 15min (cancel + force-fail)
async function handlePnrIssued(supabase: any, row: any, ageSec: number): Promise<any> {
  if (!row.duffel_order_id) {
    // Shouldn't happen — pnr_issued transition always sets duffel_order_id.
    // If it does, we can't do anything useful. Alert and skip.
    await alertFounder("UNHANDLED_ERROR", {
      function: "retry-stuck-bookings",
      merchant_ref: row.pesapal_order_id,
      pending_booking_id: row.id,
      message: "pnr_issued row has no duffel_order_id — cannot reconcile",
      severity: "HIGH",
    });
    return { outcome: "pnr_issued_no_order_id" };
  }

  // Force-fail branch (bucket 5): cancel Duffel, transition, refund.
  if (ageSec > AGE_PNR_ISSUED_FAIL_S) {
    let cancelResult: any = null;
    try {
      const cancelRes = await fetch(
        `${DUFFEL_BASE_URL}/air/orders/${row.duffel_order_id}/actions/cancel`,
        { method: "POST", headers: DUFFEL_HEADERS },
      );
      cancelResult = await cancelRes.json().catch(() => null);
      if (!cancelRes.ok) {
        console.warn(`[retry] Duffel cancel non-2xx for ${row.duffel_order_id}: ${cancelRes.status}`);
      }
    } catch (err) {
      console.error(`[retry] Duffel cancel threw for ${row.duffel_order_id}:`, err);
    }

    const { data: claimed } = await supabase
      .from("pending_bookings")
      .update({ status: "paid_booking_failed" })
      .eq("id", row.id)
      .eq("status", "pnr_issued")
      .select();
    if (!claimed || claimed.length === 0) {
      return { outcome: "skipped_pnr_issued_transitioned" };
    }
    await alertFounder("PAID_NO_TICKET", {
      merchant_ref: row.pesapal_order_id,
      pending_booking_id: row.id,
      duffel_order_id: row.duffel_order_id,
      amount_paid_kes: row.total_kes,
      customer_email: row.contact?.email,
      customer_phone: row.contact?.phone_number,
      passengers: row.passengers,
      source: "retry-stuck-bookings",
      reason: "pnr_issued > 15min, tickets never issued — cancelled at Duffel, refunding",
      duffel_cancel_response: cancelResult,
    });
    await refundBooking(
      supabase,
      "paid_booking_failed",
      row,
      row.pesapal_tracking_id,
      row.pesapal_order_id,
    );
    return { outcome: "pnr_issued_force_failed_cancelled_and_refunded" };
  }

  // Poll branch (bucket 4): check if tickets have been issued.
  let order: any = null;
  try {
    const orderRes = await fetch(
      `${DUFFEL_BASE_URL}/air/orders/${row.duffel_order_id}`,
      { headers: DUFFEL_HEADERS },
    );
    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      console.warn(`[retry] Duffel GET /air/orders/${row.duffel_order_id} → ${orderRes.status}`);
      return { outcome: "duffel_get_non_2xx", http_status: orderRes.status };
    }
    order = orderData.data;
  } catch (err) {
    console.error(`[retry] Duffel GET threw for ${row.duffel_order_id}:`, err);
    return { outcome: "duffel_get_threw", error: (err as Error).message };
  }

  if (!documentsPopulated(order)) {
    // Not yet. Next sweep will pick it up.
    return { outcome: "pnr_issued_still_no_documents" };
  }

  // Documents populated. Transition to booked + fire confirmation.
  const { data: claimed } = await supabase
    .from("pending_bookings")
    .update({ status: "booked" })
    .eq("id", row.id)
    .eq("status", "pnr_issued")
    .select();
  if (!claimed || claimed.length === 0) {
    return { outcome: "skipped_pnr_issued_transitioned" };
  }

  const email = await fireSendConfirmation(supabase, row, order);
  if (!email.ok) {
    await alertFounder("CONFIRMATION_EMAIL_FAILED", {
      merchant_ref: row.pesapal_order_id,
      pending_booking_id: row.id,
      customer_email: row.contact?.email,
      http_status: email.http_status,
      response_body: email.body,
      error: email.error,
      source: "retry-stuck-bookings (pnr_issued → booked)",
    });
    return { outcome: "pnr_issued_transitioned_email_failed" };
  }
  console.log(`[retry] pnr_issued → booked + email sent: ${row.pesapal_order_id}`);
  return { outcome: "pnr_issued_transitioned_and_email_sent" };
}

// Bucket 6: booked with NULL confirmation_email_sent_at > 60s
async function retryConfirmationEmail(supabase: any, row: any): Promise<any> {
  if (!row.duffel_order_id) {
    await alertFounder("UNHANDLED_ERROR", {
      function: "retry-stuck-bookings",
      merchant_ref: row.pesapal_order_id,
      pending_booking_id: row.id,
      message: "booked row with NULL confirmation_email_sent_at has no duffel_order_id",
      severity: "HIGH",
    });
    return { outcome: "booked_no_order_id" };
  }

  let order: any = null;
  try {
    const orderRes = await fetch(
      `${DUFFEL_BASE_URL}/air/orders/${row.duffel_order_id}`,
      { headers: DUFFEL_HEADERS },
    );
    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      return { outcome: "duffel_get_non_2xx_on_booked_retry", http_status: orderRes.status };
    }
    order = orderData.data;
  } catch (err) {
    return { outcome: "duffel_get_threw_on_booked_retry", error: (err as Error).message };
  }

  const email = await fireSendConfirmation(supabase, row, order);
  if (!email.ok) {
    await alertFounder("CONFIRMATION_EMAIL_FAILED", {
      merchant_ref: row.pesapal_order_id,
      pending_booking_id: row.id,
      customer_email: row.contact?.email,
      http_status: email.http_status,
      response_body: email.body,
      error: email.error,
      source: "retry-stuck-bookings (booked retry)",
    });
    return { outcome: "booked_email_retry_failed" };
  }
  console.log(`[retry] Confirmation email retry succeeded: ${row.pesapal_order_id}`);
  return { outcome: "booked_email_retry_succeeded" };
}

// ── Dispatch ──────────────────────────────────────────────────────────────
async function processRow(supabase: any, row: any): Promise<any> {
  const ageSec = (Date.now() - new Date(row.updated_at).getTime()) / 1000;
  try {
    if (row.status === "paid") {
      return await nudgePaidToDuffelPending(supabase, row);
    }
    if (row.status === "duffel_pending") {
      if (ageSec > AGE_DUFFEL_PENDING_FAIL_S) {
        return await forceFailDuffelPending(supabase, row);
      }
      return await nudgeProcessDuffelBooking(row);
    }
    if (row.status === "pnr_issued") {
      return await handlePnrIssued(supabase, row, ageSec);
    }
    if (row.status === "booked") {
      return await retryConfirmationEmail(supabase, row);
    }
    return { outcome: "unexpected_status", status: row.status };
  } catch (err) {
    console.error(`[retry] processRow threw for ${row.id}:`, err);
    await alertFounder("UNHANDLED_ERROR", {
      function: "retry-stuck-bookings",
      pending_booking_id: row.id,
      merchant_ref: row.pesapal_order_id,
      status: row.status,
      age_sec: Math.round(ageSec),
      error: (err as Error).message,
    });
    return { outcome: "processRow_threw", error: (err as Error).message };
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Auth: service_role via Authorization (pg_cron passes Vault secret)
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.includes(SERVICE_ROLE_KEY)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // Mode/key guard
  const modeGuard = await checkModeKeyMismatch("retry-stuck-bookings");
  if (modeGuard) return modeGuard;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const now = new Date();
    const paidThresh = new Date(now.getTime() - AGE_PAID_STUCK_S * 1000).toISOString();
    const dpThresh   = new Date(now.getTime() - AGE_DUFFEL_PENDING_NUDGE_S * 1000).toISOString();
    const pnrThresh  = new Date(now.getTime() - AGE_PNR_ISSUED_POLL_S * 1000).toISOString();
    const bookedThresh = new Date(now.getTime() - AGE_BOOKED_NO_EMAIL_S * 1000).toISOString();

    const [paidRows, dpRows, pnrRows, bookedRows] = await Promise.all([
      supabase.from("pending_bookings").select("*")
        .eq("status", "paid").lte("updated_at", paidThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT),
      supabase.from("pending_bookings").select("*")
        .eq("status", "duffel_pending").lte("updated_at", dpThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT),
      supabase.from("pending_bookings").select("*")
        .eq("status", "pnr_issued").lte("updated_at", pnrThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT),
      supabase.from("pending_bookings").select("*")
        .eq("status", "booked").is("confirmation_email_sent_at", null)
        .lte("updated_at", bookedThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT),
    ]);

    if (paidRows.error || dpRows.error || pnrRows.error || bookedRows.error) {
      await alertFounder("UNHANDLED_ERROR", {
        function: "retry-stuck-bookings",
        message: "One or more scan queries failed",
        paid_error: paidRows.error?.message,
        dp_error: dpRows.error?.message,
        pnr_error: pnrRows.error?.message,
        booked_error: bookedRows.error?.message,
      });
      return new Response(
        JSON.stringify({ error: "Scan failed" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const allRows = [
      ...(paidRows.data || []),
      ...(dpRows.data || []),
      ...(pnrRows.data || []),
      ...(bookedRows.data || []),
    ];

    if (allRows.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0 }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const results: any[] = [];
    for (const row of allRows) {
      const result = await processRow(supabase, row);
      results.push({ id: row.id, ref: row.pesapal_order_id, from_status: row.status, ...result });
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("[retry-stuck-bookings] Unhandled:", err);
    await alertFounder("UNHANDLED_ERROR", {
      function: "retry-stuck-bookings",
      message: "Top-level error",
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
