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
//
// Session 49.a step 1/7 (2026-10-16): lifted three functions out of
// duffel-webhook/index.ts so retry-stuck-bookings' Sweep R1 can share
// the same handler primitives in step 2/7. See bottom of file.
// ============================================================================

// ── Env vars ──────────────────────────────────────────────────────────────

// Session 35b task 5: Duffel API key split into READ + WRITE scopes.
//
// Duffel's permission model classifies ANY resource creation (POST) as a
// write operation, even semantically-search-like operations. Specifically:
//   - POST /air/offer_requests            → WRITE (requires air.offer_requests.create)
//   - POST /air/offers/{id}/actions/price → WRITE (freshness re-check is an "action")
//   - POST /air/orders                    → WRITE (order booking)
//   - POST /air/orders/{id}/actions/cancel → WRITE (cancellation)
//   - GET  /air/offers/{id}               → READ  (look up known offer)
//   - GET  /air/offers/{id}?return_available_services=true → READ (baggage)
//   - GET  /air/seat_maps?offer_id=...    → READ  (seat map lookup)
//
// EF assignment per this model:
//   - DUFFEL_READ_KEY:  get-offer, get-baggage-options, get-seat-maps,
//                       initialize-payment (offer re-check via GET),
//                       create-mpesa-stk (offer re-check via GET)
//   - DUFFEL_WRITE_KEY: search-flights, check-offer-freshness (POST actions/price),
//                       process-duffel-booking, mpesa-callback (booking path),
//                       paystack-webhook (booking path), retry-stuck-bookings (cancel)
//
// Split limits blast radius: if the READ key leaks, attacker who knows a
// specific offer_id can look it up — but cannot search for new offers,
// cannot create bookings, cannot cancel. If the WRITE key leaks, attacker
// can do everything, so it's held more tightly and rotated more frequently
// per SOP §1.
//
// Fallback to DUFFEL_API_KEY on unset for backward compat during rollout — any
// EF that hasn't yet been migrated still resolves to the legacy single-key env
// var. To be removed one release cycle after all EFs migrate.
export const DUFFEL_READ_KEY = Deno.env.get("DUFFEL_READ_KEY") || Deno.env.get("DUFFEL_API_KEY") || "";
export const DUFFEL_WRITE_KEY = Deno.env.get("DUFFEL_WRITE_KEY") || Deno.env.get("DUFFEL_API_KEY") || "";

/** @deprecated Use DUFFEL_READ_KEY or DUFFEL_WRITE_KEY per Session 35b task 5.
 *  Retained as fallback source for EFs not yet migrated. */
export const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY") || "";

export const DUFFEL_BASE_URL = "https://api.duffel.com";
export const DUFFEL_MODE = (Deno.env.get("DUFFEL_MODE") || "production").toLowerCase();

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

export const PAYSTACK_API_KEY = Deno.env.get("PAYSTACK_API_KEY")!;
export const PAYSTACK_MODE = (Deno.env.get("PAYSTACK_MODE") || "test").toLowerCase();
export const PAYSTACK_BASE_URL = "https://api.paystack.co";

export const SEND_CONFIRMATION_URL = `${SUPABASE_URL}/functions/v1/send-confirmation`;
export const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;
export const AUDIT_LOG_URL = `${SUPABASE_URL}/functions/v1/audit-log`;

// ── CORS ──────────────────────────────────────────────────────────────────

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-paystack-signature, x-webhook-secret",
};

// ── Webhook secret compare ────────────────────────────────────────────────
// Constant-time string compare for webhook secret verification. Prevents
// timing side-channels on comparison (theoretical for 32-byte random hex, but
// free hardening). Extracted Session 44 for reuse across webhook-target EFs
// (send-refund-notification, process-duffel-booking).
//
// NOTE: process-duffel-booking retains its own local copy for now — that EF
// is production-critical and Session 54 polish batch will migrate it. This
// shared export is used by send-refund-notification and any new webhook EFs.

export function safeCompare(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Alert helper ──────────────────────────────────────────────────────────
// Fire-and-forget alert to the alert-founder EF. Never throws.

// Session 41.b: extended 2-arg -> 3-arg (optional dedupKey) + .ok check per
// RUNBOOK §1.7. Matches heartbeat/index.ts fireAlert's wire shape exactly.
// 2-arg callers are unaffected: dedup_key is only included in the body when
// dedupKey is truthy, so the wire body is byte-identical to pre-41.b for them.
export async function alertFounder(
  alertType: string,
  context: Record<string, unknown>,
  dedupKey?: string,
) {
  try {
    const res = await fetch(ALERT_FOUNDER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        alert_type: alertType,
        context,
        ...(dedupKey ? { dedup_key: dedupKey } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `Failed to send alert (non-2xx): type=${alertType} status=${res.status} body=${body.substring(0, 300)}`,
      );
    }
  } catch (err) {
    console.error("Failed to send alert:", alertType, err);
  }
}

// ── Audit-log helper (Ops-1, Session 40) ──────────────────────────────────
// Fire-and-forget write to audit_log via the audit-log EF. Never throws.
// Uses object-param signature — 5+ params in positional form is bug-prone.
//
// Callers: paystack-webhook, process-duffel-booking, retry-stuck-bookings,
// send-refund-notification, verify-payment, send-confirmation, and any future
// EF that mutates booking/payment/refund/cancellation state.
//
// Actor convention (see audit_log migration comment for full spec):
//   actor_type = 'system'   → actor_id = source EF name
//   actor_type = 'ops'      → actor_id = ops user email
//   actor_type = 'customer' → actor_id = user_id (or 'guest:<token>' for guests)
//
// Payload discipline: never cleartext PII. Structured event context only —
// amounts, currencies, error details, state transitions, correlation IDs.

export async function auditLog(params: {
  actor_id: string;
  action_type: string;
  target_type: "pending_booking" | "booking" | "refund" | "cancellation";
  target_id: string;
  payload?: Record<string, unknown>;
  actor_type?: "system" | "ops" | "customer";
}) {
  try {
    await fetch(AUDIT_LOG_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actor_type: params.actor_type ?? "system",
        actor_id: params.actor_id,
        action_type: params.action_type,
        target_type: params.target_type,
        target_id: params.target_id,
        payload: params.payload ?? {},
      }),
    });
  } catch (err) {
    console.error("Failed to write audit log:", params.action_type, params.target_id, err);
  }
}

// ── Mode/key mismatch guard ───────────────────────────────────────────────
// Fires once at cold start if DUFFEL_MODE or PAYSTACK_MODE doesn't match
// the key prefix. All requests refused with 503 + one CRITICAL alert per
// cold start.

let MODE_KEY_OK = true;
let MODE_KEY_REASON = "";
{
  // Session 35b task 5: verify BOTH keys match the mode (read + write).
  // The legacy single-key DUFFEL_API_KEY check is preserved for the fallback
  // path — DUFFEL_READ_KEY and DUFFEL_WRITE_KEY resolve to it if unset, so
  // checking DUFFEL_READ_KEY covers the legacy case naturally.
  const isDuffelReadTest = DUFFEL_READ_KEY?.startsWith("duffel_test_");
  const isDuffelReadLive = DUFFEL_READ_KEY?.startsWith("duffel_live_");
  const isDuffelWriteTest = DUFFEL_WRITE_KEY?.startsWith("duffel_test_");
  const isDuffelWriteLive = DUFFEL_WRITE_KEY?.startsWith("duffel_live_");
  const isPaystackTest = PAYSTACK_API_KEY?.startsWith("sk_test_");
  const isPaystackLive = PAYSTACK_API_KEY?.startsWith("sk_live_");

  if (!DUFFEL_READ_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_READ_KEY not set (and DUFFEL_API_KEY fallback also unset)";
  } else if (!DUFFEL_WRITE_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "DUFFEL_WRITE_KEY not set (and DUFFEL_API_KEY fallback also unset)";
  } else if (!PAYSTACK_API_KEY) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = "PAYSTACK_API_KEY not set";
  } else if (DUFFEL_MODE === "sandbox" && (!isDuffelReadTest || !isDuffelWriteTest)) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `DUFFEL_MODE=sandbox but Duffel key(s) not test: read=${isDuffelReadTest ? "test" : "wrong"}, write=${isDuffelWriteTest ? "test" : "wrong"}`;
  } else if (DUFFEL_MODE === "production" && (!isDuffelReadLive || !isDuffelWriteLive)) {
    MODE_KEY_OK = false;
    MODE_KEY_REASON = `DUFFEL_MODE=production but Duffel key(s) not live: read=${isDuffelReadLive ? "live" : "wrong"}, write=${isDuffelWriteLive ? "live" : "wrong"}`;
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
    await alertFounder(
      "PAYSTACK_OR_DUFFEL_MODE_KEY_MISMATCH",
      { source, reason: MODE_KEY_REASON },
      `source:${source}`,
    );
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
  sourceEf: string,  // Ops-1, Session 40: attribution for refund_initiated audit
): Promise<void> {
  try {
    // Step 1: idempotent insert. Unique index on paystack_tx_id makes
    // the DB the source of truth. Any race resolves here.
    // Session 40: .select("id").single() so we can use refund.id as target_id
    // for the refund_initiated audit at end of successful path.
    const { data: refund, error: insertErr } = await supabase.from("refunds").insert({
      pending_booking_id: pending.id,
      merchant_ref: reference,
      paystack_tx_id: paystackTxId,
      amount_kes: pending.total_kes,
      reason,
      status: "pending",
      customer_email: pending.contact?.email || null,
    }).select("id").single();

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

    // Ops-1 audit (Session 40): fire only on happy path — after refund is
    // both DB-persisted AND Paystack has accepted it. Failed Paystack calls
    // above already alerted and returned; they intentionally don't audit
    // as refund_initiated because the refund wasn't actually initiated.
    if (refund?.id) {
      await auditLog({
        actor_id: sourceEf,
        action_type: "refund_initiated",
        target_type: "refund",
        target_id: refund.id,
        payload: {
          reason,
          merchant_ref: reference,
          paystack_tx_id: paystackTxId,
          paystack_refund_id: refundId,
          amount_kes: pending.total_kes,
          pending_booking_id: pending.id,  // cross-reference for booking timeline
        },
      });
    }
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

// ============================================================================
// Session 49.a step 1/7 (2026-10-16) — Duffel event-handler primitives
// ============================================================================
// Lifted from duffel-webhook/index.ts so retry-stuck-bookings' Sweep R1 can
// share the same lookup + marker + confirmation-email code paths as the
// webhook handler. Zero functional change at this point — duffel-webhook
// imports these three functions instead of defining them locally.
//
// Session 49.a step 2/7 then moves handleOrderCreated and
// handleOrderCreationFailed into _shared/duffel-order-event-handlers.ts
// (separate file to avoid _shared/duffel-helpers.ts bloat) so both callers
// run the same state-transition logic. The split between helpers (here) and
// handlers (next step) keeps the modular layering honest: handlers compose
// helpers; EFs compose handlers.
// ============================================================================

/**
 * Session 49.a: result type returned by order-event handlers to their caller.
 *
 * `resolved: true` means the handler ran its substantive work (state
 * transition, email fire, idempotent-replay recognised) and the caller
 * should mark the event row processed with `outcome` + `pendingBookingId`.
 *
 * `resolved: false` means the handler could not resolve the event to a
 * pending row by order_id OR metadata. The caller should NOT mark the event
 * row — leave `processed_at IS NULL` so the Session 49.a Sweep R1
 * reconciler classifies it with its 10-min window logic.
 *
 * Session 48 soak surfaced a new outcome `pricing_failed_after_create` for
 * the Duffel-sandbox-422 pattern where Duffel internally creates an order
 * resource but returns 422 from POST /air/orders; the pending row ends up
 * in paid_offer_expired/refunded correctly but the webhook event sits
 * unresolved. Sweep R1 writes this outcome silently (no alert). The
 * duffel-webhook inline handler never writes it directly (never knows that
 * context at write time).
 */
export type OrderEventOutcomeKind =
  | "handled_inline"
  | "race_resolved"
  | "external_order"
  | "failed"
  | "noop"
  | "pricing_failed_after_create";

export type OrderEventOutcome = {
  outcome: OrderEventOutcomeKind;
  pendingBookingId?: string | null;
  errorMsg?: string | null;
  resolved: boolean;
};

/**
 * Session 48 (spec section 2.3) — resolve a pending_bookings row from a
 * Duffel webhook event. Primary lookup is by duffel_order_id (set once
 * process-duffel-booking's UPDATE commits); fallback is by
 * metadata.pending_booking_id (the race-proof back-reference that
 * process-duffel-booking writes on POST /air/orders).
 *
 * S-14b: reads via pending_bookings_decrypted so pending.passengers is
 * plaintext for PAID_NO_TICKET alert context and other consumers.
 *
 * Session 49.a: lifted from duffel-webhook/index.ts for reuse by
 * retry-stuck-bookings' Sweep R1 reconciler.
 */
export async function findPendingByOrderIdOrMetadata(supabase: any, event: any): Promise<any> {
  const orderId = event?.data?.object?.id;
  const metaPendingId = event?.data?.object?.metadata?.pending_booking_id;

  // Primary: lookup by duffel_order_id (set once process-duffel-booking's
  // UPDATE commits).
  if (orderId) {
    const { data } = await supabase
      .from("pending_bookings_decrypted")
      .select("*")
      .eq("duffel_order_id", orderId)
      .maybeSingle();
    if (data) return data;
  }

  // Fallback: lookup by metadata (race-proof back-reference).
  if (metaPendingId) {
    const { data } = await supabase
      .from("pending_bookings_decrypted")
      .select("*")
      .eq("id", metaPendingId)
      .maybeSingle();
    if (data) return data;
  }

  return null;
}

/**
 * Session 48 (spec section 2.3) — mark a duffel_webhook_events row processed
 * with an outcome. Non-fatal: the handler already did its real work. A
 * failed marker just means Session 49 reconciler Sweep R1 will see this
 * event as unprocessed and re-run its resolution (idempotent via the same
 * compare-and-set guards on pending_bookings).
 *
 * Session 49.a: lifted from duffel-webhook/index.ts for reuse by Sweep R1.
 * The outcome union is extended by `pricing_failed_after_create` to
 * classify Duffel-sandbox-422 artifacts silently (no alert, caller
 * context only).
 */
export async function markEventProcessed(
  supabase: any,
  eventRowId: string,
  outcome: OrderEventOutcomeKind,
  opts?: { pendingBookingId?: string | null; errorMsg?: string | null },
): Promise<void> {
  if (!eventRowId) return;  // defensive; shouldn't happen in normal flow
  const update: Record<string, any> = {
    processed_at: new Date().toISOString(),
    processing_outcome: outcome,
  };
  if (opts?.pendingBookingId !== undefined) update.pending_booking_id = opts.pendingBookingId;
  if (opts?.errorMsg !== undefined) update.processing_error = opts.errorMsg;
  const { error } = await supabase
    .from("duffel_webhook_events")
    .update(update)
    .eq("id", eventRowId);
  if (error) {
    console.error(`[markEventProcessed] failed for ${eventRowId}: ${error.message}`);
  }
}

/**
 * Fire send-confirmation EF with atomic idempotency guard on
 * pending_bookings.confirmation_email_sent_at. Returns a result object
 * describing success / failure for the caller to alert on if needed.
 *
 * Session 49.a: lifted from duffel-webhook/index.ts for reuse by Sweep R1
 * when it runs the handler-equivalent on a late-resolved event.
 * retry-stuck-bookings' existing fireSendConfirmation (identical shape) is
 * replaced by this import in Session 49.a step 4+ to collapse the two
 * copies into one.
 */
export async function fireSendConfirmation(
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

/**
 * Helper: documents on a Duffel order populated with electronic ticket
 * numbers. Session 49.a lifted from duffel-webhook so handlers (next step)
 * can reference it from _shared.
 */
export function documentsPopulated(order: any): boolean {
  const docs = Array.isArray(order?.documents) ? order.documents : [];
  return docs.some((d: any) =>
    (d?.type === "electronic_ticket" || d?.type === "ticket") && d?.unique_identifier
  );
}