// ============================================================================
// duffel-webhook — Duffel-side event handler
// ============================================================================
// Session 28b commit #8. Sibling EF to paystack-webhook. Handles events
// Duffel pushes to us:
//
//   order.created — order resource created in Duffel's system. Fires either
//     as the sync-200-companion (redundant with our process-duffel-booking's
//     own POST response) or asynchronously after a 202 accepted. Payload
//     carries the full Order object at event.data.object.
//
//   order.creation_failed — a 202-accepted order failed to create later.
//     Rare. We fail the row + refund the customer.
//
// Auth: HMAC-SHA256 over "<timestamp>.<raw_body>" with DUFFEL_WEBHOOK_SECRET.
// Signature header: X-Duffel-Signature, format t=<ts>,v1=<hex>.
// 5-minute timestamp window for replay protection.
//
// Idempotency:
//   - Duffel replays webhooks on our non-2xx. Our handler is idempotent:
//     compare-and-set transitions, pre-INSERT existence check on bookings,
//     confirmation_email_sent_at atomic guard.
//   - Same-event replays land at a row that's already at booked/pnr_issued/
//     terminal — we no-op and 200.
//
// Idempotency-key note: event.idempotency_key at the top level appears to
// be the Duffel order id (ord_...). We use event.data.object.id for lookup
// and rely on our own Duffel-Idempotency-Key (== pending.id) via the
// process-duffel-booking codepath — this webhook doesn't need to know it.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  DUFFEL_API_KEY, DUFFEL_BASE_URL, DUFFEL_MODE,
  SUPABASE_URL, SERVICE_ROLE_KEY,
  SEND_CONFIRMATION_URL,
  CORS_HEADERS,
  alertFounder,
  checkModeKeyMismatch,
  refundBooking,
} from "../_shared/duffel-helpers.ts";

const DUFFEL_WEBHOOK_SECRET = Deno.env.get("DUFFEL_WEBHOOK_SECRET") || "";

const REPLAY_WINDOW_SECONDS = 300; // 5 min

// ── Signature verification (HMAC-SHA256 over "<ts>.<raw_body>") ───────────
async function verifyDuffelSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!header) return { ok: false, reason: "missing_signature_header" };
  if (!secret) return { ok: false, reason: "missing_webhook_secret_env_var" };
  if (!rawBody) return { ok: false, reason: "empty_body" };

  // Parse t=<ts>,v<version>=<hex>. Duffel's public docs (docs.duffel.com/
    // guides/receiving-webhooks) describe v1, but the runtime sends v2 as of
    // 2026-07-20. Same HMAC-SHA256 over "<ts>.<body>" — undocumented version
    // label bump only. Accept either. Verified end-to-end via Duffel Ping on
    // 2026-07-20 during Session 28b #8.
    const parts = header.split(",").map((p) => p.trim());
    let ts = "";
    let sig = "";
    let sigVersion = "";
    for (const p of parts) {
      const [k, v] = p.split("=");
      if (k === "t") ts = v || "";
      else if (k === "v1" || k === "v2") {
        sig = v || "";
        sigVersion = k;
      }
    }
    if (!ts || !sig) return { ok: false, reason: "malformed_signature_header" };

  // Replay window
  const tsInt = parseInt(ts, 10);
  if (!Number.isFinite(tsInt)) return { ok: false, reason: "non_numeric_timestamp" };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsInt) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp_outside_replay_window" };
  }

  // Compute HMAC
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signedPayload = `${ts}.${rawBody}`;
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const hexSig = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hexSig.length !== sig.length) {
          return { ok: false, reason: `signature_length_mismatch (computed=${hexSig.length}, received=${sig.length}, version=${sigVersion})` };
        }
        let diff = 0;
        for (let i = 0; i < hexSig.length; i++) {
          diff |= hexSig.charCodeAt(i) ^ sig.charCodeAt(i);
        }
        return diff === 0
              ? { ok: true }
              : { ok: false, reason: `signature_mismatch_${sigVersion}` };
  } catch (err) {
    return { ok: false, reason: `hmac_threw: ${(err as Error).message}` };
  }
}

// ── Live-mode sanity check ────────────────────────────────────────────────
// Duffel sends events tagged live_mode: true/false. Cross-check against
// our DUFFEL_MODE env var — a mismatch means an env-var misconfiguration.
function liveModeMatchesEnv(eventLiveMode: boolean): boolean {
  if (DUFFEL_MODE === "production") return eventLiveMode === true;
  if (DUFFEL_MODE === "sandbox") return eventLiveMode === false;
  return false; // unknown mode value
}

// ── Helpers ───────────────────────────────────────────────────────────────
function documentsPopulated(order: any): boolean {
  const docs = Array.isArray(order?.documents) ? order.documents : [];
  return docs.some((d: any) =>
    (d?.type === "electronic_ticket" || d?.type === "ticket") && d?.unique_identifier
  );
}

async function findPendingByDuffelOrderId(supabase: any, orderId: string): Promise<any> {
  const { data } = await supabase
    .from("pending_bookings")
    .select("*")
    .eq("duffel_order_id", orderId)
    .maybeSingle();
  return data;
}

// ── Send-confirmation caller with atomic idempotency guard ────────────────
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

// ── Event handlers ────────────────────────────────────────────────────────

async function handleOrderCreated(supabase: any, event: any): Promise<Response> {
  const order = event?.data?.object;
  if (!order?.id) {
    await alertFounder("UNHANDLED_ERROR", {
      function: "duffel-webhook",
      event_id: event?.id,
      event_type: event?.type,
      message: "order.created event has no data.object.id",
      raw_event: event,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const pending = await findPendingByDuffelOrderId(supabase, order.id);
  if (!pending) {
    // Two legit cases: (a) order created via Duffel Dashboard directly,
    // outside our system; (b) event race — process-duffel-booking hasn't
    // yet UPDATED our row with duffel_order_id. Alert HIGH not CRITICAL
    // because case (b) is expected and case (a) is not customer-impacting.
    await alertFounder("UNHANDLED_ERROR", {
      function: "duffel-webhook",
      event_type: event.type,
      duffel_order_id: order.id,
      booking_reference: order.booking_reference,
      message: "order.created event fired for a duffel_order_id we don't have a pending row for. Either (a) created outside our system (Dashboard) or (b) race with process-duffel-booking's UPDATE. Not blocking.",
      severity: "HIGH",
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
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
        await alertFounder("CONFIRMATION_EMAIL_FAILED", {
          merchant_ref: pending.pesapal_order_id,
          pending_booking_id: pending.id,
          customer_email: pending.contact?.email,
          http_status: email.http_status,
          response_body: email.body,
          error: email.error,
          source: "duffel-webhook (booked no-email replay)",
        });
      } else {
        console.log(`[duffel-webhook] Replayed → email sent for ${pending.pesapal_order_id}`);
      }
    }
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // pnr_issued → potentially booked
  if (pending.status === "pnr_issued") {
    if (!documentsPopulated(order)) {
      // Duffel event fired but documents still empty. Weird but harmless.
      console.log(`[duffel-webhook] order.created replay w/o documents for pnr_issued ${pending.pesapal_order_id}`);
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }
    const { data: claimed } = await supabase
      .from("pending_bookings")
      .update({ status: "booked" })
      .eq("id", pending.id)
      .eq("status", "pnr_issued")
      .select();
    if (!claimed || claimed.length === 0) {
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }
    const email = await fireSendConfirmation(supabase, pending, order);
    if (!email.ok) {
      await alertFounder("CONFIRMATION_EMAIL_FAILED", {
        merchant_ref: pending.pesapal_order_id,
        pending_booking_id: pending.id,
        customer_email: pending.contact?.email,
        http_status: email.http_status,
        response_body: email.body,
        error: email.error,
        source: "duffel-webhook (pnr_issued → booked)",
      });
    } else {
      console.log(`[duffel-webhook] pnr_issued → booked + email sent for ${pending.pesapal_order_id}`);
    }
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // duffel_pending — this is the 202-async recovery path. process-duffel-
  // booking got a 202, transitioned to duffel_pending (or should have),
  // and we're now getting the actual order-created event. We can complete
  // the flow: INSERT bookings, transition, fire email if documents populated.
  //
  // But: process-duffel-booking's own handling for 202 is "stay at
  // duffel_pending; reconciler polls". So we're doing the equivalent
  // work here in webhook form, faster than the reconciler.
  //
  // What we DON'T have from just the event: the offer object (needed to
  // derive itinerary details like cabin_class, fare_brand_name). Do a
  // GET /air/orders/<id> to get the fresh order with full data since the
  // event might have a stale/partial snapshot.
  if (pending.status === "duffel_pending") {
    // Nudge process-duffel-booking to do the actual work — cleaner than
    // duplicating INSERT bookings logic here. Its idempotency-key will
    // hit the existing order and complete the flow. But we need the
    // secret to nudge, and we don't have it in this EF's env (it's on
    // process-duffel-booking's side). Rather than plumbing that through,
    // fall through to: leave at duffel_pending and let retry-stuck-
    // bookings pick it up on next 60s tick.
    console.log(`[duffel-webhook] order.created received for duffel_pending row ${pending.pesapal_order_id}; retry-stuck-bookings will complete via nudge`);
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Any other state (paid, pending, etc.) — unexpected but not disaster.
  await alertFounder("UNHANDLED_ERROR", {
    function: "duffel-webhook",
    merchant_ref: pending.pesapal_order_id,
    pending_booking_id: pending.id,
    current_status: pending.status,
    duffel_order_id: order.id,
    message: "order.created event fired for row in unexpected state",
    severity: "HIGH",
  });
  return new Response("ok", { status: 200, headers: CORS_HEADERS });
}

async function handleOrderCreationFailed(supabase: any, event: any): Promise<Response> {
  const failure = event?.data?.object;
  // Duffel's order.creation_failed payload carries the failed order attempt
  // details. Look up by whatever identifier is present — Duffel populates
  // idempotency_key at the top level (which is the ord_... id).
  const orderId = failure?.id || event?.idempotency_key || "";
  if (!orderId) {
    await alertFounder("UNHANDLED_ERROR", {
      function: "duffel-webhook",
      event_id: event?.id,
      event_type: event?.type,
      message: "order.creation_failed with no identifiable order id",
      raw_event: event,
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const pending = await findPendingByDuffelOrderId(supabase, orderId);
  if (!pending) {
    await alertFounder("UNHANDLED_ERROR", {
      function: "duffel-webhook",
      event_type: event.type,
      duffel_order_id: orderId,
      message: "order.creation_failed for a duffel_order_id we don't have a pending row for",
      severity: "HIGH",
    });
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Idempotent replays
  if (["paid_booking_failed", "refund_pending", "refunded",
       "paid_offer_expired", "failed_to_create"].includes(pending.status)) {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // Force-fail whatever state we're in; refund.
  const { data: claimed } = await supabase
    .from("pending_bookings")
    .update({ status: "paid_booking_failed" })
    .eq("id", pending.id)
    .in("status", ["duffel_pending", "pnr_issued", "booked", "paid", "pending"])
    .select();
  if (!claimed || claimed.length === 0) {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  await alertFounder("PAID_NO_TICKET", {
    merchant_ref: pending.pesapal_order_id,
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
    pending.pesapal_tracking_id,
    pending.pesapal_order_id,
  );
  return new Response("ok", { status: 200, headers: CORS_HEADERS });
}

// ── HTTP handler ──────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Mode/key sanity check
  const modeGuard = await checkModeKeyMismatch("duffel-webhook");
  if (modeGuard) return modeGuard;

  // 1. Read raw body (needed for signature verification — do NOT reparse)
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "body_read_failed" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // 2. Verify signature
  const sigHeader = req.headers.get("X-Duffel-Signature") || req.headers.get("x-duffel-signature");
    const verify = await verifyDuffelSignature(rawBody, sigHeader, DUFFEL_WEBHOOK_SECRET);
    if (!verify.ok) {
        console.error(`[duffel-webhook] Signature verify failed: ${verify.reason}`);
        // Only alert on real attack signals or config problems. Bare probes to
      // the URL (missing header, empty body) are expected background noise
      // during deploys and don't page.
      const isNoisy = verify.reason === "missing_signature_header"
                   || verify.reason === "empty_body";
      if (!isNoisy) {
        await alertFounder("UNHANDLED_ERROR", {
          function: "duffel-webhook",
          message: "Signature verification failed",
          reason: verify.reason,
          severity: verify.reason === "signature_mismatch"
                    || verify.reason === "timestamp_outside_replay_window"
            ? "CRITICAL"
            : "HIGH",
        });
      }
      return new Response(
        JSON.stringify({ error: "Signature verification failed" }),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

  // 3. Parse body
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    await alertFounder("UNHANDLED_ERROR", {
      function: "duffel-webhook",
      message: "Body signature-verified but JSON parse failed",
      severity: "HIGH",
    });
    return new Response(
      JSON.stringify({ error: "invalid_json" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // 4. Live-mode cross-check
  if (typeof event?.live_mode === "boolean" && !liveModeMatchesEnv(event.live_mode)) {
    // Env var says one mode; event says other. Deeply wrong. Refuse.
    await alertFounder("DUFFEL_MODE_KEY_MISMATCH", {
      source: "duffel-webhook",
      reason: `event.live_mode=${event.live_mode} but DUFFEL_MODE=${DUFFEL_MODE}`,
    });
    return new Response(
      JSON.stringify({ error: "live_mode_mismatch" }),
      { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 5. Dispatch by event type
  try {
    switch (event?.type) {
      case "order.created":
        return await handleOrderCreated(supabase, event);
      case "order.creation_failed":
        return await handleOrderCreationFailed(supabase, event);
      case "ping.triggered":
        // Duffel sends this when a webhook is created/updated (test ping).
        console.log("[duffel-webhook] ping.triggered received");
        return new Response("ok", { status: 200, headers: CORS_HEADERS });
      default:
        console.log(`[duffel-webhook] Unhandled event type: ${event?.type}`);
        return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }
  } catch (err) {
    console.error("[duffel-webhook] Unhandled:", err);
    await alertFounder("UNHANDLED_ERROR", {
      function: "duffel-webhook",
      event_id: event?.id,
      event_type: event?.type,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    // Non-2xx → Duffel retries. Idempotency guards handle re-fires.
    return new Response(
      JSON.stringify({ error: "internal_error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
