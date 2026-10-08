// supabase/functions/send-otp/index.ts
// Supabase Auth "Send SMS" hook → Africa's Talking SMS delivery
// Verifies webhook signature using Standard Webhooks spec (Supabase's format).
//
// Session 46.a: three-part migration from silent HTTP 200 {} on failures to
// user-visible error messages, working around a gotrue action-hook limitation.
//
// Part 1 — Structured errors on failure paths. Hook returns proper HTTP
// status codes (429/500/502) with Supabase's documented error schema:
//   { error: { http_code: NNN, message: "..." } }
// Previously the EF returned 200 {} on nearly every non-happy path, causing
// silent-degrade UX (frontend showed "we sent a code" while nothing arrived).
//
// Part 2 — Discovered during Phase D smoke: Supabase Auth action hooks
// (send_sms, send_email) hardcode-mask hook response bodies with generic
// strings regardless of schema compliance:
//   non-200       -> "Service currently unavailable due to hook"
//   500           -> "Unexpected status code returned from hook: 500"
// This is architectural in gotrue, not fixable from the EF. See Session 46.a
// close bundle for the gotrue code-path research.
//
// Part 3 — Side-channel workaround. For failure paths where phone is
// reliably available (#4, #5, #6, #7), the EF upserts a row into
// public.otp_delivery_errors with the user-facing message. Frontend intercepts
// gotrue's mask strings in signInWithOtp() catch and queries this table by
// phone to display the real message. See migrations/session_s46a_otp_delivery_errors_table.sql.
//
// Paths unchanged:
//   - Happy path: HTTP 200 {}                        (hook contract success)
//   - Signature verify fail: HTTP 401 {error:"..."}  (attacker/misconfigured
//     probe path — NOT the hook contract error schema)
//
// Paths migrated to structured errors (Session 46.a):
//   - SEND_OTP_HOOK_SECRET env unset  → HTTP 500
//   - Missing phone/OTP in payload    → HTTP 500
//   - Per-phone throttle 15m hit      → HTTP 429
//   - Per-phone throttle 24h hit      → HTTP 429
//   - AT delivery HTTP non-2xx        → HTTP 502
//   - AT recipient status non-Success → HTTP 502
//   - Outer catch (unhandled)         → HTTP 500
//
// Message copy decision (§2.4 handoff): middle-fidelity. "Too many requests"
// (deliberately generic, denies attacker enumeration signal) + "please try
// again in N" (preserves retry timing for honest users).

import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { alertFounder } from "../_shared/duffel-helpers.ts";

const AT_API_KEY  = Deno.env.get("AT_API_KEY")!;
const AT_USERNAME = Deno.env.get("AT_USERNAME")!;

const AT_BASE_URL = Deno.env.get("AT_ENV") === "production"
  ? "https://api.africastalking.com/version1/messaging"
  : "https://api.sandbox.africastalking.com/version1/messaging";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

// Hook secret — set this in Supabase Edge Function secrets.
// Format from Supabase: "v1,whsec_<base64>" — strip the "v1,whsec_" prefix.
const HOOK_SECRET_RAW = Deno.env.get("SEND_OTP_HOOK_SECRET") ?? "";
const HOOK_SECRET     = HOOK_SECRET_RAW.replace(/^v1,whsec_/, "");

// ─── S-07c per-phone throttle (KYC 1.16) ────────────────────────────────────
// Rolling windows: no more than 3 requests per 15 minutes, no more than 10 per 24h.
const PHONE_WINDOW_15M_LIMIT    = 3;
const PHONE_WINDOW_24H_LIMIT    = 10;
const PHONE_WINDOW_15M_MINUTES  = 15;
const PHONE_WINDOW_24H_MINUTES  = 60 * 24;  // 1440 min; message renders as "24 hours"

// ─── S-07c helpers: SHA256 + typed alert-founder + otp_attempts DB access ────
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// alertFounderTyped migrated to shared alertFounder() in
// _shared/duffel-helpers.ts (Session 41.b consolidation). Same 3-arg shape
// (alertType, context, dedupKey?) — this was the reference implementation
// the shared helper's canonical pattern (RUNBOOK §1.7) was documented from.

// Count phone rows in otp_attempts within a rolling window.
// Returns null on infra error (caller decides fail-open behavior).
async function countPhoneAttempts(phone: string, minutes: number): Promise<number | null> {
  try {
    const windowStart = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const url =
      `${SUPABASE_URL}/rest/v1/otp_attempts` +
      `?select=id` +
      `&scope=eq.phone` +
      `&scope_value=eq.${encodeURIComponent(phone)}` +
      `&requested_at=gte.${encodeURIComponent(windowStart)}`;
    const res = await fetch(url, {
      method:  "HEAD",
      headers: {
        "apikey":        SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Prefer":        "count=exact",
      },
    });
    if (!res.ok) {
      console.error(`[send-otp] countPhoneAttempts non-2xx: status=${res.status} minutes=${minutes}`);
      return null;
    }
    const contentRange = res.headers.get("content-range") ?? "*/0";
    return parseInt(contentRange.split("/")[1] ?? "0", 10);
  } catch (e) {
    console.error(`[send-otp] countPhoneAttempts threw:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Session 46.a side-channel: write to otp_delivery_errors ─────────────────
// Supabase Auth action hooks hardcode-mask our structured error bodies with
// generic strings ("Service currently unavailable due to hook", "Unexpected
// status code returned from hook: 500"), so user never sees our retry/reason
// message directly from the hook response. Workaround: upsert the message
// here, frontend queries this table on gotrue mask detection and displays
// user_message. See migrations/session_s46a_otp_delivery_errors_table.sql.
//
// Fire-and-forget: a DB failure here must not block the hookError return.
async function recordDeliveryError(
  phone: string,
  reason: "throttled_15m" | "throttled_24h" | "at_delivery_failed" | "at_recipient_failed",
  userMessage: string,
  retryAvailableAt: Date | null,
): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/otp_delivery_errors`, {
      method:  "POST",
      headers: {
        "apikey":        SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        phone_number:       phone,
        retry_available_at: retryAvailableAt ? retryAvailableAt.toISOString() : null,
        last_reason:        reason,
        user_message:       userMessage,
        updated_at:         new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[send-otp] recordDeliveryError non-2xx: status=${res.status} reason=${reason}`);
    }
  } catch (e) {
    console.error(`[send-otp] recordDeliveryError threw:`, e instanceof Error ? e.message : e);
  }
}

// Record a phone attempt in otp_attempts.
async function recordPhoneAttempt(phone: string): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/otp_attempts`, {
      method:  "POST",
      headers: {
        "apikey":        SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({ scope: "phone", scope_value: phone }),
    });
    if (!res.ok) {
      console.error(`[send-otp] recordPhoneAttempt non-2xx: status=${res.status}`);
    }
  } catch (e) {
    console.error(`[send-otp] recordPhoneAttempt threw:`, e instanceof Error ? e.message : e);
  }
}

// ─── Legacy alertFounder(subject, body) helper removed Session 34 cleanup ────
// All call sites migrated to alertFounder(alert_type, context) above.
// New alert types registered in alert-founder: OTP_DELIVERY_FAILED,
// OTP_STATUS_NON_SUCCESS. See TumaFly_SOP_Master.md §1.1 for the SERVICE_ROLE_KEY
// canonical convention that motivated this migration.

const OK = () =>
  new Response(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// Session 46.a — Supabase Auth hook contract error schema.
// Returned on non-200 paths so Supabase Auth propagates the message to the
// frontend's signInWithOtp() catch. The body's error.http_code MUST match
// the HTTP status; any schema deviation falls back to a generic error.
const hookError = (httpCode: number, message: string) =>
  new Response(
    JSON.stringify({ error: { http_code: httpCode, message } }),
    {
      status: httpCode,
      headers: { "Content-Type": "application/json" },
    },
  );

// User-facing message copy — Session 46.a (final table, Bev-signed-off).
// These are the strings the user actually sees after Supabase Auth's hook-mask
// is intercepted by the frontend. hookError() returns them in the structured
// response (which gotrue masks away) AND recordDeliveryError() stores them
// in the side-channel table for the frontend to read.
const GENERIC_INTERNAL_ERROR = "Something went wrong sending your code. Please try again, or use another sign-in option.";
const AT_UNAVAILABLE_ERROR   = "SMS service is temporarily unavailable. Please try again shortly, or use another sign-in option.";

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();

    // ── 1. Verify signature ──────────────────────────────────────────────────
    let payload: any;
    try {
      if (!HOOK_SECRET) {
        // Session 46.a: operator config failure (secret env unset) now surfaces
        // to the user via structured 500 instead of silent 200. Pre-migration,
        // this returned 200 {} so Supabase Auth would still complete sign-in
        // flow during initial deployment bootstrap, but that produced silent-
        // degrade "code sent" UX in prod if config ever drifted.
        console.error("[send-otp] SEND_OTP_HOOK_SECRET not set");
        return hookError(500, GENERIC_INTERNAL_ERROR);
      }
      const wh = new Webhook(HOOK_SECRET);
      payload = wh.verify(rawBody, {
        "webhook-id":        req.headers.get("webhook-id")        ?? "",
        "webhook-timestamp": req.headers.get("webhook-timestamp") ?? "",
        "webhook-signature": req.headers.get("webhook-signature") ?? "",
      });
    } catch (e) {
      // Signature verification failure — attacker or misconfigured probe path.
      // Deliberately NOT the hook contract error schema (this response isn't
      // for Supabase Auth to propagate). 401 for callers lacking valid signature.
      console.error("[send-otp] Signature verification failed:", e instanceof Error ? e.message : e);
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Session 35b S-04: removed console.log of signed payload — contained phone (PII) + OTP (secret).
    // Signature verification success is implicit; failure path (line above) still logs error object.

    // ── 2. Extract phone + OTP ───────────────────────────────────────────────
    const phone = payload?.user?.phone ?? "";
    const otp   = payload?.sms?.otp   ?? "";

    if (!phone || !otp) {
      // Session 46.a: defensive guard. Unreachable from a well-formed Supabase
      // Auth hook payload (schema always has user.phone + sms.otp). If hit,
      // something is wrong at the Supabase Auth side — surface as 500 rather
      // than claim "code sent" and leave the user waiting.
      console.warn("[send-otp] Missing phone or OTP in signed payload");
      return hookError(500, GENERIC_INTERNAL_ERROR);
    }

    // ── 2.5. S-07c per-phone throttle check (KYC 1.16) ───────────────────────
    // Rolling windows: 3/15min, 10/24h per phone number.
    // Fail-open on infra errors (don't block legit users during DB outage).
    //
    // Session 46.a: throttle-hit paths now return HTTP 429 with structured
    // error schema. Supabase Auth propagates the retry-timing message to the
    // frontend's signInWithOtp() catch, so the user sees "Too many requests.
    // Please try again in N minutes." instead of "we sent a code" silence.
    // Alert still fires fire-and-forget before the return.
    const count15m = await countPhoneAttempts(phone, PHONE_WINDOW_15M_MINUTES);
    const count24h = await countPhoneAttempts(phone, PHONE_WINDOW_24H_MINUTES);

    if (count15m !== null && count15m >= PHONE_WINDOW_15M_LIMIT) {
      console.warn(`[send-otp] throttle HIT (15m window): phone_15m=${count15m} limit=${PHONE_WINDOW_15M_LIMIT}`);
      const hashedPhone = await sha256Hex(phone);
      const userMessage = `Too many requests. Please try again in ${PHONE_WINDOW_15M_MINUTES} minutes.`;
      await alertFounder("OTP_THROTTLE_HIT", {
        scope:              "phone",
        scope_value_sha256: hashedPhone,
        window_minutes:     PHONE_WINDOW_15M_MINUTES,
        limit:              PHONE_WINDOW_15M_LIMIT,
        observed_count:     count15m,
      }, `phone:${hashedPhone}`);
      // Session 46.a side-channel: write message for frontend to display.
      await recordDeliveryError(
        phone,
        "throttled_15m",
        userMessage,
        new Date(Date.now() + PHONE_WINDOW_15M_MINUTES * 60 * 1000),
      );
      return hookError(429, userMessage);
    }

    if (count24h !== null && count24h >= PHONE_WINDOW_24H_LIMIT) {
      console.warn(`[send-otp] throttle HIT (24h window): phone_24h=${count24h} limit=${PHONE_WINDOW_24H_LIMIT}`);
      const hashedPhone = await sha256Hex(phone);
      const userMessage = "Too many requests. Please try again in 24 hours, or use another sign-in option.";
      await alertFounder("OTP_THROTTLE_HIT", {
        scope:              "phone",
        scope_value_sha256: hashedPhone,
        window_minutes:     PHONE_WINDOW_24H_MINUTES,
        limit:              PHONE_WINDOW_24H_LIMIT,
        observed_count:     count24h,
      }, `phone:${hashedPhone}`);
      // Session 46.a side-channel: write message for frontend to display.
      await recordDeliveryError(
        phone,
        "throttled_24h",
        userMessage,
        new Date(Date.now() + PHONE_WINDOW_24H_MINUTES * 60 * 1000),
      );
      return hookError(429, userMessage);
    }

    // Under both limits — record this attempt, then proceed to SMS send.
    await recordPhoneAttempt(phone);

    // ── 3. Send via Africa's Talking ─────────────────────────────────────────
    const message = `Your TumaFly verification code is: ${otp}. Valid for 10 minutes.`;
    const formBody = new URLSearchParams({
      username: AT_USERNAME,
      to:       phone.startsWith("+") ? phone : `+${phone}`,
      message,
      // Uncomment once TUMAFLY alphanumeric sender ID is approved by AT:
      // from: "TUMAFLY",
    });

    console.log(`[send-otp] Sending OTP to ${phone} via ${AT_BASE_URL}`);

    const atResponse = await fetch(AT_BASE_URL, {
      method: "POST",
      headers: {
        "Accept":       "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "apiKey":       AT_API_KEY,
      },
      body: formBody.toString(),
    });

    // Session 46.a (follow-up): check atResponse.ok BEFORE parsing JSON.
    // AT returns PLAINTEXT error bodies on auth failures (e.g., "The supplied
    // authentication is invalid" when AT_API_KEY is unset or wrong), which
    // crash .json() with a SyntaxError. Pre-this-fix, that SyntaxError bubbled
    // to the outer catch and returned generic 500 — but 502 is the correct
    // status for AT failures, so we handle non-2xx first without parsing.
    // Pre-migration this bug was masked by outer catch returning OK() 200.
    if (!atResponse.ok) {
      // Try to extract a message snippet for the alert, but don't require JSON
      // (AT returns plaintext on auth failures; we don't want to crash again).
      let atMessageSnippet = "(not parsed — non-2xx response)";
      try {
        const bodyText = await atResponse.text();
        atMessageSnippet = bodyText.substring(0, 200);
      } catch (_e) {
        // ignore — body unreadable
      }
      console.error(`[send-otp] AT delivery failed status=${atResponse.status} snippet="${atMessageSnippet}"`);
      await alertFounder(
        "OTP_DELIVERY_FAILED",
        {
          phone_sha256:   await sha256Hex(phone),
          at_http_status: atResponse.status,
          at_message:     atMessageSnippet,
        },
        `at_http_status:${atResponse.status}`,
      );
      // Session 46.a side-channel: write message for frontend to display.
      await recordDeliveryError(
        phone,
        "at_delivery_failed",
        AT_UNAVAILABLE_ERROR,
        null,
      );
      return hookError(502, AT_UNAVAILABLE_ERROR);
    }

    // 2xx response — now safe to parse as JSON. If AT misbehaves and returns
    // 2xx with non-JSON body (shouldn't happen per their docs, but defensive),
    // treat it as a delivery failure rather than crash.
    let result: any;
    try {
      result = await atResponse.json();
    } catch (e) {
      console.error(`[send-otp] AT 2xx response not JSON:`, e instanceof Error ? e.message : e);
      await alertFounder(
        "OTP_DELIVERY_FAILED",
        {
          phone_sha256:   await sha256Hex(phone),
          at_http_status: atResponse.status,
          at_message:     "(2xx but non-JSON body)",
        },
        `at_http_status:${atResponse.status}_nonjson`,
      );
      // Session 46.a side-channel: write message for frontend to display.
      await recordDeliveryError(
        phone,
        "at_delivery_failed",
        AT_UNAVAILABLE_ERROR,
        null,
      );
      return hookError(502, AT_UNAVAILABLE_ERROR);
    }
    // Session 35b S-04: removed console.log of AT response — result.SMSMessageData.Recipients
    // may echo phone. Success is implicit from atResponse.status check above.

    const recipients = result?.SMSMessageData?.Recipients ?? [];
    const failed = recipients.filter((r: { status: string }) => r.status !== "Success");
    if (failed.length > 0) {
      // Session 46.a: AT returned HTTP 2xx but recipient status reports failure.
      // Same user-visible outcome as HTTP non-2xx (no SMS arrives), so same
      // structured 502 for consistency. Pre-migration this fell through to
      // the happy-path OK() at the bottom of the handler.
      const firstFailed = failed[0] as { status?: string; statusCode?: number };
      console.error(`[send-otp] AT non-Success failed_count=${failed.length} first_status=${firstFailed?.status ?? "unknown"}`);
      await alertFounder(
        "OTP_STATUS_NON_SUCCESS",
        {
          phone_sha256:   await sha256Hex(phone),
          at_status_code: firstFailed?.statusCode ?? 0,
          at_message:     typeof firstFailed?.status === "string" ? firstFailed.status.substring(0, 200) : "no-status",
        },
        `at_status_code:${firstFailed?.statusCode ?? 0}`,
      );
      // Session 46.a side-channel: distinct message for recipient-level failure
      // (AT accepted but delivery failed) — likely bad number format or blocked
      // carrier, so point user at the number as the thing to fix.
      await recordDeliveryError(
        phone,
        "at_recipient_failed",
        "We couldn't send a code to this number. Please check it's correct or try a different number.",
        null,
      );
      return hookError(502, AT_UNAVAILABLE_ERROR);
    }

    return OK();

  } catch (e) {
    // Session 46.a: outer catch now returns structured 500 instead of silent
    // 200. Any unhandled exception reaches here; user sees generic error
    // instead of "we sent a code" with nothing to follow.
    console.error("[send-otp] Unexpected error:", e instanceof Error ? e.message : e);
    return hookError(500, GENERIC_INTERNAL_ERROR);
  }
});