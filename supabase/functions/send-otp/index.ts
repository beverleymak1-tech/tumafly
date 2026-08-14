// supabase/functions/send-otp/index.ts
// Supabase Auth "Send SMS" hook → Africa's Talking SMS delivery
// Verifies webhook signature using Standard Webhooks spec (Supabase's format).

import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const AT_API_KEY  = Deno.env.get("AT_API_KEY")!;
const AT_USERNAME = Deno.env.get("AT_USERNAME")!;

const AT_BASE_URL = Deno.env.get("AT_ENV") === "production"
  ? "https://api.africastalking.com/version1/messaging"
  : "https://api.sandbox.africastalking.com/version1/messaging";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SERVICE_ROLE_KEY")!;

// Hook secret — set this in Supabase Edge Function secrets.
// Format from Supabase: "v1,whsec_<base64>" — strip the "v1,whsec_" prefix.
const HOOK_SECRET_RAW = Deno.env.get("SEND_OTP_HOOK_SECRET") ?? "";
const HOOK_SECRET     = HOOK_SECRET_RAW.replace(/^v1,whsec_/, "");

// ─── S-07c per-phone throttle (KYC 1.16) ────────────────────────────────────
// Rolling windows: no more than 3 requests per 15 minutes, no more than 10 per 24h.
const PHONE_WINDOW_15M_LIMIT = 3;
const PHONE_WINDOW_24H_LIMIT = 10;

// ─── S-07c helpers: SHA256 + typed alert-founder + otp_attempts DB access ────
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Typed alert-founder call (S-02 shape). Use for all NEW alerts.
// Legacy alertFounder(subject, body) below is pre-existing tech debt — do not
// use for new work; migrate incrementally in S-04 log-hygiene sweep.
async function alertFounderTyped(alert_type: string, context: Record<string, unknown>, dedup_key?: string) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/alert-founder`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ alert_type, context, dedup_key }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[send-otp] alertFounderTyped non-2xx: status=${res.status} type=${alert_type} body=${body.substring(0, 300)}`);
    }
  } catch (e) {
    console.error(`[send-otp] alertFounderTyped threw for type=${alert_type}:`, e instanceof Error ? e.message : e);
  }
}

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
        "apikey":        SUPABASE_SERVICE_ROLE,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
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

// Record a phone attempt in otp_attempts.
async function recordPhoneAttempt(phone: string): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/otp_attempts`, {
      method:  "POST",
      headers: {
        "apikey":        SUPABASE_SERVICE_ROLE,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
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

// ─── Legacy alert-founder helper (pre-existing, kept for existing callers) ───
async function alertFounder(subject: string, body: string) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/alert-founder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ subject, body }),
    });
  } catch (e) {
    console.error("[send-otp] alertFounder failed:", e);
  }
}

const OK = () =>
  new Response(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();

    // ── 1. Verify signature ──────────────────────────────────────────────────
    let payload: any;
    try {
      if (!HOOK_SECRET) {
        console.error("[send-otp] SEND_OTP_HOOK_SECRET not set");
        return OK();
      }
      const wh = new Webhook(HOOK_SECRET);
      payload = wh.verify(rawBody, {
        "webhook-id":        req.headers.get("webhook-id")        ?? "",
        "webhook-timestamp": req.headers.get("webhook-timestamp") ?? "",
        "webhook-signature": req.headers.get("webhook-signature") ?? "",
      });
    } catch (e) {
      console.error("[send-otp] Signature verification failed:", e instanceof Error ? e.message : e);
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log("[send-otp] Verified payload:", JSON.stringify(payload));

    // ── 2. Extract phone + OTP ───────────────────────────────────────────────
    const phone = payload?.user?.phone ?? "";
    const otp   = payload?.sms?.otp   ?? "";

    if (!phone || !otp) {
          console.warn("[send-otp] Missing phone or OTP — returning 200 (no-op)");
          return OK();
        }

        // ── 2.5. S-07c per-phone throttle check (KYC 1.16) ───────────────────────
        // Rolling windows: 3/15min, 10/24h per phone number.
        // Fail-open on infra errors (don't block legit users during DB outage).
        // On throttle hit: alert founder (fire-and-forget), return 200 (Supabase
        // Auth still thinks "OTP sent" — but no SMS actually sent, which is the
        // whole point of the throttle).
        const count15m = await countPhoneAttempts(phone, 15);
        const count24h = await countPhoneAttempts(phone, 60 * 24);

        if (count15m !== null && count15m >= PHONE_WINDOW_15M_LIMIT) {
          console.warn(`[send-otp] throttle HIT (15m window): phone_15m=${count15m} limit=${PHONE_WINDOW_15M_LIMIT}`);
          const hashedPhone = await sha256Hex(phone);
                await alertFounderTyped("OTP_THROTTLE_HIT", {
                  scope:              "phone",
                  scope_value_sha256: hashedPhone,
                  window_minutes:     15,
                  limit:              PHONE_WINDOW_15M_LIMIT,
                  observed_count:     count15m,
                }, `phone:${hashedPhone}`);
                return OK();
              }

              if (count24h !== null && count24h >= PHONE_WINDOW_24H_LIMIT) {
          console.warn(`[send-otp] throttle HIT (24h window): phone_24h=${count24h} limit=${PHONE_WINDOW_24H_LIMIT}`);
          const hashedPhone = await sha256Hex(phone);
                await alertFounderTyped("OTP_THROTTLE_HIT", {
                  scope:              "phone",
                  scope_value_sha256: hashedPhone,
                  window_minutes:     60 * 24,
                  limit:              PHONE_WINDOW_24H_LIMIT,
                  observed_count:     count24h,
                }, `phone:${hashedPhone}`);
                return OK();
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

    const result = await atResponse.json();
    console.log("[send-otp] AT response:", JSON.stringify(result));

    if (!atResponse.ok) {
      const msg = `Africa's Talking SMS delivery failed (${atResponse.status}).\nPhone: ${phone}\nResponse: ${JSON.stringify(result)}`;
      console.error("[send-otp]", msg);
      await alertFounder("⚠️ TumaFly OTP delivery failed", msg);
      return OK();
    }

    const recipients = result?.SMSMessageData?.Recipients ?? [];
    const failed = recipients.filter((r: { status: string }) => r.status !== "Success");
    if (failed.length > 0) {
      const msg = `AT returned non-Success status for OTP.\nPhone: ${phone}\nFailed recipients: ${JSON.stringify(failed)}`;
      console.error("[send-otp]", msg);
      await alertFounder("⚠️ TumaFly OTP status non-Success", msg);
    }

    return OK();

  } catch (e) {
    console.error("[send-otp] Unexpected error:", e instanceof Error ? e.message : e);
    return OK();
  }
});