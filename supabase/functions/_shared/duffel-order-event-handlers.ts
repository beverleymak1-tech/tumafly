// ============================================================================
// _shared/duffel-order-event-handlers.ts — Duffel order event state logic
// ============================================================================
//
// Session 49.a step 2/7 (2026-10-16): lifted from duffel-webhook/index.ts so
// retry-stuck-bookings' Sweep R1 reconciler (step 5/7) can call the exact
// same state-transition logic the webhook handler runs inline. This closes
// the "two code paths with different correctness properties" risk: both
// callers now compose the same handler primitives from _shared/duffel-helpers.ts
// and apply the same compare-and-set guards + alert fires + idempotent-replay
// recognition.
//
// What stays in duffel-webhook/index.ts:
//   - HTTP serve wrapper (OPTIONS, signature verify, raw-body read)
//   - Eager-capture UPSERT into duffel_webhook_events
//   - Replay short-circuit on processed_at
//   - Live-mode cross-check against DUFFEL_MODE env var
//   - Outcome → markEventProcessed call + Response("ok", 200) translation
//
// What's here:
//   - handleOrderCreated:        order.created event → state transition + email
//   - handleOrderCreationFailed: order.creation_failed → force-fail + refund
//
// Both handlers return OrderEventOutcome. See _shared/duffel-helpers.ts for
// the type definition and semantics of `resolved: true` vs `resolved: false`.
// ============================================================================

import {
  alertFounder,
  refundBooking,
  findPendingByOrderIdOrMetadata,
  fireSendConfirmation,
  documentsPopulated,
  type OrderEventOutcome,
} from "./duffel-helpers.ts";

/**
 * Handle an `order.created` Duffel webhook event.
 *
 * Resolution order:
 *   1. Lookup pending row by duffel_order_id OR metadata.pending_booking_id.
 *   2. If no match → return { resolved: false, outcome: "noop" }. Caller
 *      leaves duffel_webhook_events.processed_at NULL so Sweep R1
 *      classifies after its 10-min window (external_order vs edge race).
 *   3. If row is in a terminal state → idempotent replay path (re-fire
 *      email only if booked+no-email+docs populated).
 *   4. If row is pnr_issued + docs populated → transition to booked + fire
 *      confirmation email.
 *   5. If row is duffel_pending → log and leave; Sweep R2 reasons on the
 *      pending_bookings row state (not on event.processed_at).
 *   6. Any other row state → fire DUFFEL_UNEXPECTED_ROW_STATE HIGH.
 *
 * Session 49.a step 2/7: identical to the pre-step-2 inline implementation
 * in duffel-webhook/index.ts (which was itself written in Session 48 step
 * 4/10). Pure move — no behaviour change.
 */
export async function handleOrderCreated(
  supabase: any,
  event: any,
): Promise<OrderEventOutcome> {
  const order = event?.data?.object;
  if (!order?.id) {
    // Bad event shape — Duffel sent an order.created without data.object.id.
    // Kept as UNHANDLED_ERROR (handler author did not anticipate this).
    // No duffel_order_id available so dedup-key suffix refinement doesn't
    // apply.
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "duffel-webhook",
        event_id: event?.id,
        event_type: event?.type,
        message: "order.created event has no data.object.id",
        raw_event: event,
      },
      `function:duffel-webhook+reason:created_missing_object_id`,
    );
    return {
      resolved: true,
      outcome: "failed",
      errorMsg: "order.created event has no data.object.id",
    };
  }

  // S48 (spec section 2.3): resolve by duffel_order_id OR by
  // metadata.pending_booking_id. The metadata fallback closes case (b)
  // races where process-duffel-booking's UPDATE committing duffel_order_id
  // hasn't yet landed.
  const pending = await findPendingByOrderIdOrMetadata(supabase, event);
  if (!pending) {
    // S48 (spec section 5.2 — REMOVAL): formerly fired UNHANDLED_ERROR HIGH
    // for every event we couldn't resolve. Removed — the metadata fallback
    // now closes the inline race case, so a true null here means either
    // (a) a Dashboard-created external order OR (b) a race window we failed
    // to close by metadata too.
    //
    // Leave processed_at IS NULL on the event row. Session 49 reconciler
    // Sweep R1 classifies after its 10min window:
    //   external_order → fire DUFFEL_ORDER_UNKNOWN_ORIGIN HIGH
    //   still-plausible edge → retry sweep
    console.log(
      `[duffel-webhook] order.created unresolved by order_id/metadata; leaving for reconciler (event_id=${event.id})`,
    );
    return { resolved: false, outcome: "noop" };
  }

  // Idempotent replays: row already at booked or terminal
  if (["booked", "refund_pending", "refunded", "paid_offer_expired",
       "paid_booking_failed", "failed_to_create"].includes(pending.status)) {
    // Re-fire email only if booked with NULL confirmation_email_sent_at
    // AND the current order shows documents populated.
    if (pending.status === "booked"
        && !pending.confirmation_email_sent_at
        && documentsPopulated(order)) {
      const email = await fireSendConfirmation(supabase, pending, order);
      if (!email.ok) {
        await alertFounder(
          "CONFIRMATION_EMAIL_FAILED",
          {
            merchant_ref: pending.merchant_ref,
            pending_booking_id: pending.id,
            customer_email: pending.contact?.email,
            http_status: email.http_status,
            response_body: email.body,
            error: email.error,
            source: "duffel-webhook (booked no-email replay)",
          },
          `pending_booking_id:${pending.id}`,
        );
      } else {
        console.log(`[duffel-webhook] Replayed → email sent for ${pending.merchant_ref}`);
      }
    }
    return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
  }

  // pnr_issued → potentially booked
  if (pending.status === "pnr_issued") {
    if (!documentsPopulated(order)) {
      // Duffel event fired but documents still empty. Weird but harmless.
      console.log(`[duffel-webhook] order.created replay w/o documents for pnr_issued ${pending.merchant_ref}`);
      return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
    }
    const { data: claimed } = await supabase
      .from("pending_bookings")
      .update({ status: "booked" })
      .eq("id", pending.id)
      .eq("status", "pnr_issued")
      .select();
    if (!claimed || claimed.length === 0) {
      return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
    }
    const email = await fireSendConfirmation(supabase, pending, order);
    if (!email.ok) {
      await alertFounder(
        "CONFIRMATION_EMAIL_FAILED",
        {
          merchant_ref: pending.merchant_ref,
          pending_booking_id: pending.id,
          customer_email: pending.contact?.email,
          http_status: email.http_status,
          response_body: email.body,
          error: email.error,
          source: "duffel-webhook (pnr_issued → booked)",
        },
        `pending_booking_id:${pending.id}`,
      );
    } else {
      console.log(`[duffel-webhook] pnr_issued → booked + email sent for ${pending.merchant_ref}`);
    }
    return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
  }

  // duffel_pending — process-duffel-booking got a 202 (or race) and hasn't
  // completed yet. The row stays at duffel_pending; retry-stuck-bookings
  // picks it up on next tick (currently paused — see RUNBOOK §13).
  // Session 49 Sweep R2 reads duffel_webhook_events for this
  // pending_booking_id and alerts PAID_NO_TICKET if the event stream shows
  // order.created but the row is still duffel_pending past the sweep
  // window. We mark the event handled_inline here — Sweep R2's reasoning
  // is on the pending_bookings row state, not on event.processed_at.
  if (pending.status === "duffel_pending") {
    console.log(
      `[duffel-webhook] order.created received for duffel_pending row ${pending.merchant_ref}; retry-stuck-bookings or Sweep R2 will complete`,
    );
    return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
  }

  // S48 (spec section 5.2 — DOWNGRADE): any other state (paid, pending,
  // etc.) — unexpected but not disaster. Downgraded from UNHANDLED_ERROR
  // CRITICAL to DUFFEL_UNEXPECTED_ROW_STATE HIGH with per-pending_booking_id
  // dedup (1h cooldown).
  await alertFounder(
    "DUFFEL_UNEXPECTED_ROW_STATE",
    {
      function: "duffel-webhook",
      event_type: event.type,
      merchant_ref: pending.merchant_ref,
      pending_booking_id: pending.id,
      current_status: pending.status,
      duffel_order_id: order.id,
    },
    `pending_booking_id:${pending.id}`,
  );
  return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
}

/**
 * Handle an `order.creation_failed` Duffel webhook event.
 *
 * Resolution order:
 *   1. Lookup pending row by duffel_order_id OR metadata.pending_booking_id.
 *   2. If no match → return { resolved: false, outcome: "noop" }. Caller
 *      leaves duffel_webhook_events.processed_at NULL.
 *   3. If row is in a terminal state → idempotent replay no-op.
 *   4. Otherwise claim transition to paid_booking_failed, fire
 *      PAID_NO_TICKET CRITICAL, trigger refundBooking.
 *
 * Session 49.a step 2/7: identical to the pre-step-2 inline implementation
 * in duffel-webhook/index.ts (sourceEf param was added in step 1/7 to fix
 * a pre-existing missing-arg bug).
 */
export async function handleOrderCreationFailed(
  supabase: any,
  event: any,
): Promise<OrderEventOutcome> {
  const failure = event?.data?.object;
  // Duffel's order.creation_failed payload carries the failed order attempt
  // details. Look up by whatever identifier is present — Duffel populates
  // idempotency_key at the top level (which is the ord_... id).
  const orderId = failure?.id || event?.idempotency_key || "";
  if (!orderId) {
    // Bad event shape — kept as UNHANDLED_ERROR. No duffel_order_id
    // available so dedup-key suffix refinement doesn't apply.
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "duffel-webhook",
        event_id: event?.id,
        event_type: event?.type,
        message: "order.creation_failed with no identifiable order id",
        raw_event: event,
      },
      `function:duffel-webhook+reason:creation_failed_missing_id`,
    );
    return {
      resolved: true,
      outcome: "failed",
      errorMsg: "order.creation_failed with no identifiable order id",
    };
  }

  // S48 (spec section 2.3): resolve by order_id OR metadata.
  const pending = await findPendingByOrderIdOrMetadata(supabase, event);
  if (!pending) {
    // S48 (spec section 5.2 — REMOVAL): formerly fired UNHANDLED_ERROR
    // HIGH. Removed — same rationale as handleOrderCreated's null branch.
    // Session 49 reconciler classifies after its window.
    console.log(
      `[duffel-webhook] order.creation_failed unresolved by order_id/metadata; leaving for reconciler (event_id=${event.id}, duffel_order_id=${orderId})`,
    );
    return { resolved: false, outcome: "noop" };
  }

  // Idempotent replays
  if (["paid_booking_failed", "refund_pending", "refunded",
       "paid_offer_expired", "failed_to_create"].includes(pending.status)) {
    return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
  }

  // Force-fail whatever state we're in; refund.
  const { data: claimed } = await supabase
    .from("pending_bookings")
    .update({ status: "paid_booking_failed" })
    .eq("id", pending.id)
    .in("status", ["duffel_pending", "pnr_issued", "booked", "paid", "pending"])
    .select();
  if (!claimed || claimed.length === 0) {
    return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
  }
  await alertFounder("PAID_NO_TICKET", {
    merchant_ref: pending.merchant_ref,
    pending_booking_id: pending.id,
    duffel_order_id: orderId,
    amount_paid_kes: pending.total_kes,
    customer_email: pending.contact?.email,
    customer_phone: pending.contact?.phone_number,
    passengers: pending.passengers,
    source: "duffel-webhook (order.creation_failed)",
    duffel_failure: failure,
  });
  await refundBooking(
    supabase,
    "paid_booking_failed",
    pending,
    pending.processor_transaction_id,
    pending.merchant_ref,
    "duffel-webhook",  // Session 49.a: sourceEf for refund_initiated audit
  );
  return { resolved: true, outcome: "handled_inline", pendingBookingId: pending.id };
}