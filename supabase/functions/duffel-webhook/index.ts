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
// Idempotency (Session 48 redesign — spec section 2.3):
//   - Every signature-verified event is eager-captured into
//     duffel_webhook_events (UNIQUE on event_id) BEFORE dispatch. Replays
//     short-circuit to 200 at the eager-capture layer, below any handler
//     re-work.
//   - Compare-and-set transitions, pre-INSERT existence check on bookings,
//     and confirmation_email_sent_at atomic guards remain as belt-and-braces.
//
// Lookup redesign (Session 48 — spec section 2.3):
//   - findPendingByOrderIdOrMetadata resolves the pending row by
//     duffel_order_id first, falling back to metadata.pending_booking_id
//     echoed back on the event. This closes the case (b) race where our
//     own UPDATE committing duffel_order_id hasn't landed yet.
//   - Unresolved events (no match by order_id OR metadata) are LEFT with
//     processed_at IS NULL for the Session 49 reconciler Sweep R1 to
//     classify (external order vs genuine edge race). No inline alert on
//     this case -- the former L220/L367 UNHANDLED_ERROR fires are removed
//     per spec section 5.2.
//
// Session 49.a step 1/7 (2026-10-16) refactor:
//   - markEventProcessed, findPendingByOrderIdOrMetadata, fireSendConfirmation,
//     and documentsPopulated are now imported from _shared/duffel-helpers.ts
//     so retry-stuck-bookings' Sweep R1 can share them in step 2+.
//   - handleOrderCreated + handleOrderCreationFailed now return
//     OrderEventOutcome instead of Response. The serve-level wrapper
//     translates outcome → markEventProcessed call + Response("ok", 200).
//     Zero functional change — same DB writes, same alerts, same HTTP
//     responses. The purpose of the shape change is isolability + reuse.
//
// Session 49.a step 2/7 (2026-10-16) refactor:
//   - handleOrderCreated + handleOrderCreationFailed moved to
//     _shared/duffel-order-event-handlers.ts so retry-stuck-bookings'
//     Sweep R1 reconciler imports and runs the exact same state-transition
//     logic the webhook handler runs inline. Zero functional change — pure
//     file move; the handlers' bodies are byte-identical to step 1/7's
//     versions.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  DUFFEL_MODE,
  SUPABASE_URL, SERVICE_ROLE_KEY,
  CORS_HEADERS,
  alertFounder,
  checkModeKeyMismatch,
  // Session 49.a step 1/7: lifted shared primitives
  markEventProcessed,
  type OrderEventOutcome,
} from "../_shared/duffel-helpers.ts";

// Session 49.a step 2/7: handlers lifted to _shared/duffel-order-event-handlers.ts
import {
  handleOrderCreated,
  handleOrderCreationFailed,
} from "../_shared/duffel-order-event-handlers.ts";

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
        // Kept as UNHANDLED_ERROR (spec section 5.2 — KEEP). No parsed event
        // yet so no duffel_order_id available for dedup-key suffix.
        await alertFounder(
          "UNHANDLED_ERROR",
          {
            function: "duffel-webhook",
            message: "Signature verification failed",
            reason: verify.reason,
            severity: (verify.reason?.startsWith("signature_mismatch_")
                       || verify.reason === "timestamp_outside_replay_window")
              ? "CRITICAL"
              : "HIGH",
          },
          `function:duffel-webhook+reason:${verify.reason}`,
        );
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
    // Kept as UNHANDLED_ERROR (spec section 5.2 — KEEP). Body unparseable
    // so no event.id or duffel_order_id for dedup-key suffix.
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "duffel-webhook",
        message: "Body signature-verified but JSON parse failed",
        severity: "HIGH",
      },
      `function:duffel-webhook+reason:body_parse_failed`,
    );
    return new Response(
      JSON.stringify({ error: "invalid_json" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // 4. Live-mode cross-check
  if (typeof event?.live_mode === "boolean" && !liveModeMatchesEnv(event.live_mode)) {
    // Env var says one mode; event says other. Deeply wrong. Refuse.
    await alertFounder(
      "DUFFEL_MODE_KEY_MISMATCH",
      {
        source: "duffel-webhook",
        reason: `event.live_mode=${event.live_mode} but DUFFEL_MODE=${DUFFEL_MODE}`,
      },
      `source:duffel-webhook`,
    );
    return new Response(
      JSON.stringify({ error: "live_mode_mismatch" }),
      { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 5. S48 (spec section 2.3) — EAGER-CAPTURE: persist signature-verified
  // event into duffel_webhook_events BEFORE dispatch. UNIQUE on event_id
  // makes replays safe no-ops at this layer, below any handler re-work.
  // Insert-then-select-on-conflict pattern because Supabase client's upsert
  // semantics around "return the row whether new or existing" vary by
  // client version. This pattern is explicit and version-independent.
  let eventRowId = "";
  let alreadyProcessed = false;
  try {
    const eventRow = {
      event_id: event.id,
      event_type: event.type,
      event_created_at: event.created_at ?? new Date().toISOString(),
      live_mode: !!event.live_mode,
      duffel_order_id: event?.data?.object?.id ?? null,
      payload: event,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from("duffel_webhook_events")
      .insert(eventRow)
      .select("id, processed_at")
      .single();
    if (insertErr) {
      // 23505 = unique_violation (replay — same event_id already captured).
      // Also match on error message for client-version drift robustness.
      const isDup = insertErr.code === "23505"
        || /duplicate key/i.test(insertErr.message || "")
        || /already exists/i.test(insertErr.message || "");
      if (isDup) {
        const { data: existing, error: selectErr } = await supabase
          .from("duffel_webhook_events")
          .select("id, processed_at")
          .eq("event_id", event.id)
          .single();
        if (selectErr || !existing) {
          throw new Error(`duplicate_event_but_select_failed: ${selectErr?.message || "no row"}`);
        }
        eventRowId = existing.id;
        alreadyProcessed = !!existing.processed_at;
      } else {
        throw insertErr;
      }
    } else {
      eventRowId = inserted.id;
      alreadyProcessed = false;
    }
  } catch (err) {
    // Rare: DB unavailable or constraint issue not a replay. Return 500 so
    // Duffel retries — we must NOT ack an event we didn't persist.
    console.error("[duffel-webhook] Eager-capture failed:", err);
    await alertFounder(
      "DUFFEL_WEBHOOK_PERSIST_FAILED",
      {
        function: "duffel-webhook",
        event_id: event?.id,
        event_type: event?.type,
        duffel_order_id: event?.data?.object?.id,
        error: (err as Error).message,
      },
      `event_id:${event?.id}`,
    );
    return new Response(
      JSON.stringify({ error: "persist_failed" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // Replay short-circuit: if processed_at was already set on an earlier
  // delivery of the same event_id, this is a safe no-op.
  if (alreadyProcessed) {
    console.log(`[duffel-webhook] Replay: event ${event.id} already processed, no-op`);
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  // 6. Dispatch by event type — handlers (lifted to _shared in S49a step 2/7)
  //    return OrderEventOutcome. The wrapper translates outcome →
  //    markEventProcessed call + Response.
  try {
    let result: OrderEventOutcome;
    switch (event?.type) {
      case "order.created":
        result = await handleOrderCreated(supabase, event);
        break;
      case "order.creation_failed":
        result = await handleOrderCreationFailed(supabase, event);
        break;
      case "ping.triggered":
        // Duffel sends this when a webhook is created/updated (test ping).
        console.log("[duffel-webhook] ping.triggered received");
        result = { resolved: true, outcome: "noop" };
        break;
      default:
        console.log(`[duffel-webhook] Unhandled event type: ${event?.type}`);
        result = { resolved: true, outcome: "noop" };
        break;
    }

    // Only mark the event processed when the handler resolved it. When
    // `resolved: false`, leave processed_at NULL so Session 49 reconciler
    // Sweep R1 classifies it after its 10-min window.
    if (result.resolved) {
      await markEventProcessed(supabase, eventRowId, result.outcome, {
        pendingBookingId: result.pendingBookingId,
        errorMsg: result.errorMsg,
      });
    }

    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("[duffel-webhook] Unhandled:", err);
    // S48 (spec section 5.1) dedup refinement: include duffel_order_id when
    // available so a sustained ambient failure on one order dedupes to one
    // alert instead of once per 15min for 24h straight.
    const duffelOrderId = event?.data?.object?.id;
    const dedupKey = duffelOrderId
      ? `function:duffel-webhook+reason:dispatch_exception+order:${duffelOrderId}`
      : `function:duffel-webhook+reason:dispatch_exception`;
    await alertFounder(
      "UNHANDLED_ERROR",
      {
        function: "duffel-webhook",
        event_id: event?.id,
        event_type: event?.type,
        duffel_order_id: duffelOrderId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      dedupKey,
    );
    await markEventProcessed(supabase, eventRowId, "failed", {
      errorMsg: (err as Error).message,
    });
    // Non-2xx → Duffel retries. Idempotency guards handle re-fires.
    return new Response(
      JSON.stringify({ error: "internal_error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});