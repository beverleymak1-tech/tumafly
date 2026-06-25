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
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Hook secret — set this in Supabase Edge Function secrets.
// Format from Supabase: "v1,whsec_<base64>" — strip the "v1,whsec_" prefix.
const HOOK_SECRET_RAW = Deno.env.get("SEND_OTP_HOOK_SECRET") ?? "";
const HOOK_SECRET     = HOOK_SECRET_RAW.replace(/^v1,whsec_/, "");

// ─── alert-founder helper ────────────────────────────────────────────────────
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