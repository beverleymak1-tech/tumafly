// ============================================================================
// retry-stuck-bookings — v2 (Session 28b commit #9)
// ============================================================================
// State-transition reconciler. Not a booking-creator. Runs every minute via
// pg_cron (job id 1, schedule '* * * * *').
//
// Six sweep buckets (age-based, per-state) + two Session 49.a reconciler
// sweeps:
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
//     Session 49.a step 6/7 will replace this with Sweep R2 which uses
//     duffel_webhook_events as the source of truth instead of a Duffel API
//     call (closes the race window where Duffel has the order but our
//     webhook event stream also has it, which is strictly more informative).
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
//     Session 49.a step 4/7 added:
//       - 14d date filter: only rows created in last 14 days are eligible.
//         Historical backlogs (e.g. the S-14b/c encrypted-view migration
//         window of 2026-09-06 → 2026-09-10, 55 rows cleaned under SOP §13
//         on 2026-10-15) stay out of this bucket forever. SOP §13 is the
//         manual-ops path for those.
//       - Pre-scan COUNT(*) backlog alert: if more than 10 rows match the
//         Bucket 6 shape, fire STUCK_BOOKING_BACKLOG_EXCEEDS_THRESHOLD
//         HIGH with dedup `bucket:6` (one email per day while sustained).
//       - Per-bucket batch size: Bucket 6 drains up to 10 rows per sweep
//         (vs default 5 for other buckets).
//
//   Sweep R1 — event-stream reconciliation (Session 49.a step 5/7, THIS COMMIT)
//     Scans duffel_webhook_events WHERE processed_at IS NULL ORDER BY
//     received_at ASC LIMIT 20. These are events the inline duffel-webhook
//     handler could not resolve (no match by order_id OR metadata at
//     dispatch time). Session 47 design spec §2.4 classification:
//       - Row NOW found via findPendingByOrderIdOrMetadata (race belatedly
//         resolved) → re-run the shared handler
//         (_shared/duffel-order-event-handlers.ts). Mark event
//         processing_outcome='race_resolved', pending_booking_id=…
//       - Row NOT found AND event has metadata.pending_booking_id AND
//         that pending row is in a terminal failure state
//         [paid_offer_expired, paid_booking_failed, refund_pending,
//         refunded, failed_to_create] → Duffel-sandbox-422 artifact
//         (Session 48 soak-close finding, 8 KQ/PW/TC/W2/WB rows). Mark
//         processing_outcome='pricing_failed_after_create'. SILENT —
//         no alert. Extension to spec §2.4 resolution union.
//       - Row NOT found AND received_at > 10min ago → external order
//         (Dashboard-created, no metadata). Mark
//         processing_outcome='external_order', fire DUFFEL_ORDER_UNKNOWN_ORIGIN
//         with dedup event_id:${event_id}.
//       - Row NOT found AND received_at < 10min ago → still-plausible edge
//         race. Leave processed_at NULL, retry next sweep.
//     Imports handleOrderCreated / handleOrderCreationFailed from
//     _shared/duffel-order-event-handlers.ts (Session 49.a steps 1-2/7
//     made this possible). Per spec §2.4: any handler-ran outcome →
//     mark race_resolved; the "idempotent replay vs state transition"
//     distinction doesn't matter at reconciler time.
//
//   Sweep R2 — stuck-pending reconciliation (Session 49.a step 6/7, NEXT COMMIT)
//     Will replace Bucket 3's forceFailDuffelPending. Reads duffel_webhook_events
//     for events matching stuck pending rows (by duffel_order_id OR
//     metadata.pending_booking_id). Delegates PAID_NO_TICKET alerts +
//     refund+fail decisions off event-stream truth, not Duffel API calls
//     (which the current forceFailDuffelPending gets wrong because
//     ?duffel_idempotency_key=X is not a supported Duffel API filter).
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
// Batch sizing: BATCH_LIMIT_DEFAULT = 5 for most buckets, BATCH_LIMIT_BUCKET_6
// = 10 for the booked-no-email bucket, BATCH_LIMIT_SWEEP_R1 = 20 for the
// event-stream reconciler (events are cheap to classify — most are
// terminal-state resolutions or 10-min-window checks, not Duffel API calls).
// Cron every minute → up to 45 operations/sweep → well above real recovery
// throughput for any single sweep.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  DUFFEL_WRITE_KEY, DUFFEL_BASE_URL,
  SUPABASE_URL, SERVICE_ROLE_KEY,
  SEND_CONFIRMATION_URL,
  CORS_HEADERS,
  alertFounder,
  checkModeKeyMismatch,
  refundBooking,
  // Session 49.a step 5/7: Sweep R1 imports the lifted primitives
  findPendingByOrderIdOrMetadata,
  markEventProcessed,
} from "../_shared/duffel-helpers.ts";

// Session 49.a step 5/7: Sweep R1 imports the lifted handlers directly.
// Both callers (duffel-webhook inline, retry-stuck-bookings Sweep R1) now
// compose the same state-transition logic. See
// TumaFly_Session47_DesignSpec_DuffelWebhookRedesign.md §2.4 Sweep R1.
import {
  handleOrderCreated,
  handleOrderCreationFailed,
} from "../_shared/duffel-order-event-handlers.ts";

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

// Session 49.a step 4/7 — Bucket 6 safety clause constants
//
// 14-day date filter on created_at (Bucket 6 scan only). Prevents the
// retry-stuck-bookings cron, when unpaused in Session 49.b, from re-sweeping
// the historical 55-row S-14b/c encrypted-view window backlog cleaned
// 2026-10-15 under SOP §13 — or any future historical backlog that enters
// a similar silent-accrual pattern. SOP §13 manual-ops is the authoritative
// path for anything older than 14 days.
const BUCKET_6_DATE_FILTER_DAYS = 14;

// Per-bucket batch sizing. Bucket 6 drains up to 10 rows per sweep (email
// retries are cheap; alert threshold is 10, so 10/sweep lets drain match
// alert signal). Other buckets stay at 5 (Duffel API calls are expensive +
// rate-limited; refund paths touch Paystack).
const BATCH_LIMIT_DEFAULT  = 5;
const BATCH_LIMIT_BUCKET_6 = 10;

// Pre-scan threshold: COUNT(*) of Bucket 6 candidates above this triggers
// STUCK_BOOKING_BACKLOG_EXCEEDS_THRESHOLD alert (HIGH, dedup `bucket:6` per
// day — see alert-founder/index.ts). 10 chosen deliberately: catches the
// Session-40.b-shaped self-DoS pattern (which built up ~50 rows before
// anyone noticed because the alert dedup collapsed CONFIRMATION_EMAIL_FAILED
// to one-per-day) early enough that an operator can intervene within one
// cron tick of accrual.
const BACKLOG_ALERT_THRESHOLD = 10;

// Session 49.a step 5/7 — Sweep R1 constants
//
// Batch size: 20 events per sweep. Classification is cheap (mostly in-memory
// predicate checks + the shared handler on resolved rows). Spec §2.4
// expectation is "~0 events per sweep for normal booking traffic" because
// metadata lookup resolves inline at the webhook handler. Non-zero sustained
// volume = either Dashboard-created orders or genuine edge cases worth
// investigating; 20 is enough headroom to drain backlogs quickly.
const BATCH_LIMIT_SWEEP_R1 = 20;

// 10-minute window for the "row not found" classification. Below the window,
// the inline webhook handler + process-duffel-booking's UPDATE committing
// duffel_order_id are still plausibly racing. Above the window, a genuine
// resolve-by-metadata or resolve-by-order_id failure means either a
// Dashboard-created external order (actionable: fire DUFFEL_ORDER_UNKNOWN_ORIGIN)
// or an unexplained gap. Spec §2.4 uses 10min.
const SWEEP_R1_RESOLUTION_WINDOW_S = 600;

// Terminal failure states a pending row ends up in when a Duffel-sandbox-422
// pattern completes. The Session 48 soak-close finding (2026-10-15, 8 unresolved
// events traced to KQ/PW/TC/W2/WB carriers) showed Duffel internally creates
// an order resource but returns 422 from POST /air/orders; our pending row
// correctly moves through paid_offer_expired/paid_booking_failed and gets
// refunded via refundBooking, but Duffel's downstream webhook event never
// matches our (never-set) duffel_order_id. Metadata-fallback catches it in
// Sweep R1 — if the pending row resolves to any of these terminal states,
// we silently classify the event rather than firing a mis-targeted alert.
const PENDING_TERMINAL_FAILURE_STATES = [
  "paid_offer_expired",
  "paid_booking_failed",
  "refund_pending",
  "refunded",
  "failed_to_create",
];

const DUFFEL_HEADERS = {
  Authorization: `Bearer ${DUFFEL_WRITE_KEY}`,
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
  console.log(`[retry] paid → duffel_pending: ${row.merchant_ref}`);
  return { outcome: "nudged_paid_to_duffel_pending" };
}

// Bucket 2: duffel_pending 60s - 5min (nudge)
async function nudgeProcessDuffelBooking(row: any): Promise<any> {
  if (!PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET) {
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "retry-stuck-bookings",
        merchant_ref: row.merchant_ref,
        message: "PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET not set — cannot nudge",
      },
      `function:retry-stuck-bookings+reason:missing_webhook_secret`,
    );
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
    console.log(`[retry] nudged process-duffel-booking for ${row.merchant_ref} → ${nudgeRes.status}`);
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
    console.warn(`[retry] Duffel GET (idempotency lookup) threw for ${row.merchant_ref}:`, err);
    // Fall through as if not found. Next sweep will retry.
  }

  if (orderExistsAtDuffel) {
    // Duffel has the order but process-duffel-booking never finished. Bug
    // territory. Alert loudly and LEAVE THE ROW at duffel_pending. Do NOT
    // refund a customer who actually got their booking created.
    await alertFounder("PAID_NO_TICKET", {
      severity: "CRITICAL",
      merchant_ref: row.merchant_ref,
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
    merchant_ref: row.merchant_ref,
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
    row.processor_transaction_id,
    row.merchant_ref,
    "retry-stuck-bookings",  // Session 40: sourceEf for refund_initiated audit attribution
  );
  return { outcome: "duffel_pending_force_failed_and_refund_initiated" };
}

// Bucket 4: pnr_issued 60s - 15min (poll for ticket issuance)
// Bucket 5: pnr_issued > 15min (cancel + force-fail)
async function handlePnrIssued(supabase: any, row: any, ageSec: number): Promise<any> {
  if (!row.duffel_order_id) {
    // Shouldn't happen — pnr_issued transition always sets duffel_order_id.
    // If it does, we can't do anything useful. Alert and skip.
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "retry-stuck-bookings",
        merchant_ref: row.merchant_ref,
        pending_booking_id: row.id,
        message: "pnr_issued row has no duffel_order_id — cannot reconcile",
        severity: "HIGH",
      },
      `function:retry-stuck-bookings+reason:pnr_issued_no_order_id`,
    );
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
      merchant_ref: row.merchant_ref,
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
      row.processor_transaction_id,
      row.merchant_ref,
      "retry-stuck-bookings",  // Session 40: sourceEf for refund_initiated audit attribution
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
    await alertFounder(
      "CONFIRMATION_EMAIL_FAILED",
      {
        merchant_ref: row.merchant_ref,
        pending_booking_id: row.id,
        customer_email: row.contact?.email,
        http_status: email.http_status,
        response_body: email.body,
        error: email.error,
        source: "retry-stuck-bookings (pnr_issued → booked)",
      },
      `pending_booking_id:${row.id}`,
    );
    return { outcome: "pnr_issued_transitioned_email_failed" };
  }
  console.log(`[retry] pnr_issued → booked + email sent: ${row.merchant_ref}`);
  return { outcome: "pnr_issued_transitioned_and_email_sent" };
}

// Bucket 6: booked with NULL confirmation_email_sent_at > 60s
async function retryConfirmationEmail(supabase: any, row: any): Promise<any> {
  if (!row.duffel_order_id) {
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "retry-stuck-bookings",
        merchant_ref: row.merchant_ref,
        pending_booking_id: row.id,
        message: "booked row with NULL confirmation_email_sent_at has no duffel_order_id",
        severity: "HIGH",
      },
      `function:retry-stuck-bookings+reason:booked_no_order_id`,
    );
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
    await alertFounder(
      "CONFIRMATION_EMAIL_FAILED",
      {
        merchant_ref: row.merchant_ref,
        pending_booking_id: row.id,
        customer_email: row.contact?.email,
        http_status: email.http_status,
        response_body: email.body,
        error: email.error,
        source: "retry-stuck-bookings (booked retry)",
      },
      `pending_booking_id:${row.id}`,
    );
    return { outcome: "booked_email_retry_failed" };
  }
  console.log(`[retry] Confirmation email retry succeeded: ${row.merchant_ref}`);
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
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "retry-stuck-bookings",
        pending_booking_id: row.id,
        merchant_ref: row.merchant_ref,
        status: row.status,
        age_sec: Math.round(ageSec),
        error: (err as Error).message,
      },
      `function:retry-stuck-bookings+reason:process_row_threw`,
    );
    return { outcome: "processRow_threw", error: (err as Error).message };
  }
}

// ── Session 49.a step 4/7 — Bucket 6 pre-scan backlog alert ───────────────
// Fire-and-forget COUNT(*) of Bucket 6 candidates. If count exceeds
// BACKLOG_ALERT_THRESHOLD, fire STUCK_BOOKING_BACKLOG_EXCEEDS_THRESHOLD
// HIGH with dedup `bucket:6` (one email per day while sustained — see
// alert-founder/index.ts). This runs BEFORE the main scan so the operator
// sees the alert even if the scan subsequently drains some rows below the
// threshold within the same invocation (the alert is about accrual rate,
// not instantaneous snapshot).
//
// Caller passes the SAME shape as the Bucket 6 scan uses (bookedThresh +
// fourteenDaysAgoISO) so there's no drift between what triggers the alert
// and what the scan processes. Any divergence would be a bug.
async function checkBucket6BacklogAndAlert(
  supabase: any,
  bookedThresh: string,
  fourteenDaysAgoISO: string,
): Promise<void> {
  try {
    const { count, error } = await supabase
      .from("pending_bookings_decrypted")
      .select("id", { count: "exact", head: true })
      .eq("status", "booked")
      .is("confirmation_email_sent_at", null)
      .lte("updated_at", bookedThresh)
      .gte("created_at", fourteenDaysAgoISO);

    if (error) {
      console.error("[retry] Bucket 6 pre-scan COUNT failed (proceeding):", error.message);
      // Fail-open — don't block the drain on a count-query failure. If the
      // backlog is real, the main scan will still see rows and process them;
      // we'll just miss this alert fire. Not catastrophic.
      return;
    }

    const totalBacklog = count ?? 0;
    console.log(`[retry] Bucket 6 pre-scan backlog count: ${totalBacklog}`);

    if (totalBacklog > BACKLOG_ALERT_THRESHOLD) {
      await alertFounder(
        "STUCK_BOOKING_BACKLOG_EXCEEDS_THRESHOLD",
        {
          bucket: 6,
          scan_shape: "booked AND confirmation_email_sent_at IS NULL AND updated_at <= threshold AND created_at >= 14d_ago",
          backlog_count: totalBacklog,
          threshold: BACKLOG_ALERT_THRESHOLD,
          date_filter_days: BUCKET_6_DATE_FILTER_DAYS,
          booked_threshold_s: AGE_BOOKED_NO_EMAIL_S,
          per_sweep_drain_limit: BATCH_LIMIT_BUCKET_6,
          source: "retry-stuck-bookings pre-scan",
        },
        `bucket:6`,
      );
    }
  } catch (err) {
    console.error("[retry] Bucket 6 pre-scan threw (proceeding):", err);
    // Same fail-open rationale.
  }
}

// ── Session 49.a step 5/7 — Sweep R1 (event-stream reconciliation) ────────
// Scans duffel_webhook_events WHERE processed_at IS NULL ORDER BY received_at
// ASC LIMIT BATCH_LIMIT_SWEEP_R1. Classifies each unprocessed event per
// Session 47 Design Spec §2.4 Sweep R1 + Session 49.a extension:
//
//   1. Row NOW found via findPendingByOrderIdOrMetadata:
//      → re-run the shared handler (same code the webhook dispatcher runs
//        inline). Spec §2.4: "Row now found → run handleOrderCreated logic
//        ... Mark event processed_at=now, outcome='race_resolved'". We
//        override whatever outcome the handler returns to 'race_resolved'
//        because by Sweep R1 time, the handler running at all means the
//        race belatedly resolved. The handler's own 'handled_inline' vs
//        'race_resolved' distinction (idempotent-replay vs state-transition)
//        doesn't matter at reconciler time.
//
//   2. Row NOT found AND event has metadata.pending_booking_id AND that
//      pending row is in PENDING_TERMINAL_FAILURE_STATES (Session 48 soak-
//      close finding — Duffel-sandbox-422 artifact pattern):
//      → silently classify as 'pricing_failed_after_create'. No alert.
//        This is an extension to the spec §2.4 resolution union, added for
//        the 8 unresolved events traced on 2026-10-15 to KQ/PW/TC/W2/WB
//        carriers. The pending row went through its correct terminal
//        failure path; the webhook event is a Duffel-side artifact we
//        just need to mark processed.
//
//   3. Row NOT found AND received_at > SWEEP_R1_RESOLUTION_WINDOW_S:
//      → external order (Dashboard-created, no metadata). Mark
//        'external_order', fire DUFFEL_ORDER_UNKNOWN_ORIGIN HIGH with
//        dedup `event_id:${event_id}` (1h cooldown).
//
//   4. Row NOT found AND received_at <= SWEEP_R1_RESOLUTION_WINDOW_S:
//      → still-plausible edge race. Leave processed_at NULL, retry next
//        sweep.
//
// Imports from _shared (Session 49.a steps 1-2/7):
//   - findPendingByOrderIdOrMetadata (lookup helper)
//   - markEventProcessed (writer with the processing_outcome union)
//   - handleOrderCreated, handleOrderCreationFailed (the actual state
//     transition logic — same code the webhook dispatcher runs inline)
//
// Each event is processed independently; a failure on one event logs +
// alerts + continues to the next. Sweep R1 as a whole never throws out of
// its own try/catch — the outer serve handler's catch wraps everything.

async function sweepUnprocessedEvents(supabase: any): Promise<any[]> {
  const results: any[] = [];

  // 1. Fetch unprocessed events, oldest first (per spec §2.2 index design).
  const { data: events, error: scanErr } = await supabase
    .from("duffel_webhook_events")
    .select("*")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(BATCH_LIMIT_SWEEP_R1);

  if (scanErr) {
    console.error("[sweep-r1] scan failed:", scanErr.message);
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "retry-stuck-bookings",
        sweep: "R1",
        message: "duffel_webhook_events scan failed",
        error: scanErr.message,
      },
      `function:retry-stuck-bookings+reason:sweep_r1_scan_failed`,
    );
    return results;
  }

  if (!events || events.length === 0) {
    return results;
  }

  console.log(`[sweep-r1] processing ${events.length} unprocessed events`);

  const nowMs = Date.now();

  for (const eventRow of events) {
    try {
      // Reconstruct the event object the shared handlers expect. The
      // duffel_webhook_events row stores the full raw event body at `payload`.
      const event = eventRow.payload;
      const eventId = eventRow.id;  // row PK, not Duffel's event.id
      const eventTypeFromRow = eventRow.event_type;
      const receivedAtMs = new Date(eventRow.received_at).getTime();
      const ageSec = (nowMs - receivedAtMs) / 1000;

      // Classification 1: row NOW found → re-run handler, mark race_resolved.
      const pending = await findPendingByOrderIdOrMetadata(supabase, event);
      if (pending) {
        // Only order.created / order.creation_failed have handler logic to
        // re-run. ping.triggered and other noop event types should never
        // land here with processed_at IS NULL (duffel-webhook marks them
        // immediately), but defensively classify if they do.
        if (eventTypeFromRow === "order.created") {
          const result = await handleOrderCreated(supabase, event);
          await markEventProcessed(supabase, eventId, "race_resolved", {
            pendingBookingId: result.pendingBookingId ?? pending.id,
            errorMsg: result.errorMsg ?? null,
          });
          results.push({
            event_id: eventRow.event_id,
            event_type: eventTypeFromRow,
            classification: "race_resolved",
            pending_booking_id: pending.id,
            handler_outcome: result.outcome,
          });
        } else if (eventTypeFromRow === "order.creation_failed") {
          const result = await handleOrderCreationFailed(supabase, event);
          await markEventProcessed(supabase, eventId, "race_resolved", {
            pendingBookingId: result.pendingBookingId ?? pending.id,
            errorMsg: result.errorMsg ?? null,
          });
          results.push({
            event_id: eventRow.event_id,
            event_type: eventTypeFromRow,
            classification: "race_resolved",
            pending_booking_id: pending.id,
            handler_outcome: result.outcome,
          });
        } else {
          // Defensive: unknown event type with a resolved pending row.
          // Mark handled_inline with the pending reference so the forensic
          // trail is complete. No handler runs; nothing to re-do.
          await markEventProcessed(supabase, eventId, "handled_inline", {
            pendingBookingId: pending.id,
          });
          results.push({
            event_id: eventRow.event_id,
            event_type: eventTypeFromRow,
            classification: "unknown_type_resolved",
            pending_booking_id: pending.id,
          });
        }
        continue;
      }

      // Row NOT found. Three sub-branches by metadata + age.
      const metaPendingId = event?.data?.object?.metadata?.pending_booking_id;

      // Classification 2: metadata resolves to a terminal failure state.
      // Duffel-sandbox-422 artifact — Session 48 soak-close finding, Session
      // 49.a extension to spec §2.4. Silent classification, no alert.
      if (metaPendingId) {
        const { data: metaPending } = await supabase
          .from("pending_bookings")
          .select("id, status")
          .eq("id", metaPendingId)
          .maybeSingle();
        if (metaPending && PENDING_TERMINAL_FAILURE_STATES.includes(metaPending.status)) {
          await markEventProcessed(supabase, eventId, "pricing_failed_after_create", {
            pendingBookingId: metaPending.id,
          });
          results.push({
            event_id: eventRow.event_id,
            event_type: eventTypeFromRow,
            classification: "pricing_failed_after_create",
            pending_booking_id: metaPending.id,
            pending_status: metaPending.status,
          });
          continue;
        }
      }

      // Classification 3: no resolution AND event is old enough → external order.
      if (ageSec > SWEEP_R1_RESOLUTION_WINDOW_S) {
        await alertFounder(
          "DUFFEL_ORDER_UNKNOWN_ORIGIN",
          {
            source: "retry-stuck-bookings Sweep R1",
            event_id: eventRow.event_id,
            event_type: eventTypeFromRow,
            duffel_order_id: eventRow.duffel_order_id,
            received_at: eventRow.received_at,
            age_sec: Math.round(ageSec),
            resolution_window_s: SWEEP_R1_RESOLUTION_WINDOW_S,
            metadata_pending_booking_id: metaPendingId ?? null,
          },
          `event_id:${eventRow.event_id}`,
        );
        await markEventProcessed(supabase, eventId, "external_order");
        results.push({
          event_id: eventRow.event_id,
          event_type: eventTypeFromRow,
          classification: "external_order",
          age_sec: Math.round(ageSec),
        });
        continue;
      }

      // Classification 4: still-plausible edge race. Leave processed_at NULL;
      // next sweep will reclassify once age crosses the window.
      results.push({
        event_id: eventRow.event_id,
        event_type: eventTypeFromRow,
        classification: "leave_for_next_sweep",
        age_sec: Math.round(ageSec),
      });
    } catch (err) {
      console.error(`[sweep-r1] failed on event_id=${eventRow.event_id}:`, err);
      await alertFounder(
        "UNHANDLED_ERROR",
        {
          function: "retry-stuck-bookings",
          sweep: "R1",
          event_id: eventRow.event_id,
          event_type: eventRow.event_type,
          duffel_order_id: eventRow.duffel_order_id,
          error: (err as Error).message,
        },
        `function:retry-stuck-bookings+reason:sweep_r1_event_threw+event:${eventRow.event_id}`,
      );
      // Do NOT mark the event processed — leave it for the next sweep to retry.
      results.push({
        event_id: eventRow.event_id,
        event_type: eventRow.event_type,
        classification: "sweep_r1_threw",
        error: (err as Error).message,
      });
    }
  }

  return results;
}

// ── HTTP handler ──────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Auth: service_role via Authorization (pg_cron passes Vault secret)
  const authHeader = req.headers.get("Authorization") || "";
  // Strip optional "Bearer " prefix (pg_cron's net.http_post historically has
  // sent both formats). Constant-time compare would be marginally stronger,
  // but the key is high-entropy JWT + hits before any DB touch.
  const presented = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim();
  if (presented !== SERVICE_ROLE_KEY) {
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
    // Session 49.a step 4/7: Bucket 6 date-filter floor. Anything older than
    // this is handled by SOP §13 manual-ops path, not by this sweep.
    const fourteenDaysAgoISO = new Date(
      now.getTime() - BUCKET_6_DATE_FILTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Session 49.a step 4/7: pre-scan Bucket 6 backlog + fire alert if
    // threshold exceeded. Fire-and-forget — runs in parallel with the main
    // scan Promise.all so a slow count query cannot block the drain.
    const backlogAlertPromise = checkBucket6BacklogAndAlert(
      supabase, bookedThresh, fourteenDaysAgoISO,
    );

    // S-14b: read via pending_bookings_decrypted so row.passengers is plaintext
    // in PAID_NO_TICKET alert contexts (buckets 3, 5). Buckets 1, 2, 4, 6 don't
    // read row.passengers themselves — nudges + Duffel calls + fireSendConfirmation
    // only touch id/contact/order — but consistency-of-shape matters for future dev.
    //
    // Session 49.a step 4/7: Bucket 6 scan adds .gte created_at filter and
    // uses BATCH_LIMIT_BUCKET_6 (10) vs BATCH_LIMIT_DEFAULT (5) for other buckets.
    const [paidRows, dpRows, pnrRows, bookedRows] = await Promise.all([
      supabase.from("pending_bookings_decrypted").select("*")
        .eq("status", "paid").lte("updated_at", paidThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT_DEFAULT),
      supabase.from("pending_bookings_decrypted").select("*")
        .eq("status", "duffel_pending").lte("updated_at", dpThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT_DEFAULT),
      supabase.from("pending_bookings_decrypted").select("*")
        .eq("status", "pnr_issued").lte("updated_at", pnrThresh)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT_DEFAULT),
      supabase.from("pending_bookings_decrypted").select("*")
        .eq("status", "booked").is("confirmation_email_sent_at", null)
        .lte("updated_at", bookedThresh)
        .gte("created_at", fourteenDaysAgoISO)
        .order("updated_at", { ascending: true }).limit(BATCH_LIMIT_BUCKET_6),
    ]);

    if (paidRows.error || dpRows.error || pnrRows.error || bookedRows.error) {
      await alertFounder(
        "UNHANDLED_ERROR",
        {
          function: "retry-stuck-bookings",
          message: "One or more scan queries failed",
          paid_error: paidRows.error?.message,
          dp_error: dpRows.error?.message,
          pnr_error: pnrRows.error?.message,
          booked_error: bookedRows.error?.message,
        },
        `function:retry-stuck-bookings+reason:scan_query_failed`,
      );
      // Await the backlog promise so a late alert fire isn't lost on request
      // close. Fire-and-forget is fine mid-handler; we tidy at the exit.
      await backlogAlertPromise.catch(() => {});
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

    // Session 49.a step 5/7: Sweep R1 runs independently of the pending_bookings
    // sweep. Even on a "nothing to drain" early-return path, we still process
    // unresolved webhook events. R1's work is cheap when there are no events.
    const sweepR1Results = await sweepUnprocessedEvents(supabase);

    if (allRows.length === 0) {
      // Same backlog-alert housekeeping on the no-rows path.
      await backlogAlertPromise.catch(() => {});
      return new Response(
        JSON.stringify({ processed: 0, sweep_r1: sweepR1Results }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const results: any[] = [];
    for (const row of allRows) {
      const result = await processRow(supabase, row);
      results.push({ id: row.id, ref: row.merchant_ref, from_status: row.status, ...result });
    }

    // Final housekeeping: ensure the backlog alert fire has completed before
    // the request closes. By this point the main scan already took ~100-500ms
    // so the promise is almost certainly resolved; the await is a safety net.
    await backlogAlertPromise.catch(() => {});

    return new Response(
      JSON.stringify({ processed: results.length, results, sweep_r1: sweepR1Results }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("[retry-stuck-bookings] Unhandled:", err);
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "retry-stuck-bookings",
        message: "Top-level error",
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      `function:retry-stuck-bookings+reason:top_level_catch`,
    );
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});