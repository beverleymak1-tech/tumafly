import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FOUNDER_EMAIL = Deno.env.get("FOUNDER_EMAIL")!; // e.g. founder@tumafly.com
const FOUNDER_NAME = Deno.env.get("FOUNDER_NAME") || "TumaFly Founder";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

type AlertType =
  | "PAID_NO_OFFER"        // customer paid, Duffel offer expired before we could book
  | "PAID_NO_TICKET"       // customer paid, Duffel rejected the booking
  | "BOOKED_NO_DB_RECORD"  // ticket issued but our DB write failed
  | "AMOUNT_MISMATCH"      // Pesapal reported a different amount than expected
  | "PAYMENT_FAILED"       // payment didn't complete (informational only)
  | "UNHANDLED_ERROR";     // webhook crashed

const ALERT_CONFIG: Record<AlertType, { severity: string; subject: string; action: string }> = {
  PAID_NO_OFFER: {
    severity: "🚨 CRITICAL",
    subject: "Customer paid but Duffel offer expired",
    action: "REFUND or RE-BOOK at current price. Contact customer immediately.",
  },
  PAID_NO_TICKET: {
    severity: "🚨 CRITICAL",
    subject: "Customer paid but ticket issuance failed",
    action: "Investigate Duffel error. Either retry booking manually or refund. Contact customer NOW.",
  },
  BOOKED_NO_DB_RECORD: {
    severity: "⚠️ HIGH",
    subject: "Ticket issued but DB write failed",
    action: "Manually insert booking record. Ticket is valid in Duffel — customer is OK, but our records are out of sync.",
  },
  AMOUNT_MISMATCH: {
    severity: "⚠️ HIGH",
    subject: "Pesapal amount does not match expected total",
    action: "Investigate. May indicate tampering or Pesapal bug. Contact customer to confirm.",
  },
  PAYMENT_FAILED: {
    severity: "ℹ️ INFO",
    subject: "Payment did not complete",
    action: "No action needed unless customer reaches out.",
  },
  UNHANDLED_ERROR: {
    severity: "🚨 CRITICAL",
    subject: "Unhandled error in webhook",
    action: "Check logs. May indicate an outage.",
  },
};

function buildEmailHtml(
  alertType: AlertType,
  context: Record<string, unknown>,
): string {
  const cfg = ALERT_CONFIG[alertType];
  const contextRows = Object.entries(context)
    .map(([k, v]) => `<tr>
      <td style="padding:6px 12px;color:#666;font-family:monospace;font-size:12px;border-bottom:1px solid #eee;vertical-align:top;">${k}</td>
      <td style="padding:6px 12px;font-family:monospace;font-size:12px;border-bottom:1px solid #eee;word-break:break-all;">${
        typeof v === "object" ? JSON.stringify(v, null, 2).replace(/\n/g, "<br>") : String(v)
      }</td>
    </tr>`)
    .join("");

  return `
<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f7f9fc;font-family:-apple-system,Helvetica,Arial,sans-serif;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr>
      <td style="background:#dc2626;color:#fff;padding:20px 24px;">
        <div style="font-size:13px;opacity:0.9;font-weight:600;letter-spacing:0.05em;">${cfg.severity}</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;">${cfg.subject}</div>
        <div style="font-size:12px;opacity:0.85;margin-top:4px;">Alert type: ${alertType}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;border-bottom:1px solid #eee;">
        <div style="font-size:13px;color:#666;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Action required</div>
        <div style="font-size:15px;color:#111;line-height:1.5;">${cfg.action}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;">
        <div style="font-size:13px;color:#666;text-transform:uppercase;font-weight:600;margin-bottom:12px;">Context</div>
        <table width="100%" cellpadding="0" cellspacing="0">${contextRows}</table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 24px;background:#f9fafb;font-size:12px;color:#666;text-align:center;">
        Sent by TumaFly system · ${new Date().toISOString()}
      </td>
    </tr>
  </table>
</body></html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Internal function — require service role auth header
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.includes(SERVICE_ROLE_KEY)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { alert_type, context } = await req.json();

    if (!alert_type || !ALERT_CONFIG[alert_type as AlertType]) {
      return new Response(JSON.stringify({ error: "Invalid alert_type" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const cfg = ALERT_CONFIG[alert_type as AlertType];
    const html = buildEmailHtml(alert_type as AlertType, context || {});

    // Send email via Resend
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TumaFly Alerts <alerts@tumafly.com>",
        to: [FOUNDER_EMAIL],
        subject: `${cfg.severity} ${cfg.subject}`,
        html,
      }),
    });

    const emailData = await emailRes.json();

    // Log Resend failures so we know exactly what went wrong (previously silent)
    if (!emailRes.ok) {
      console.error("Resend email failed:", JSON.stringify(emailData));
    }

    // Also log the alert to a table for audit/dashboard later
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    await supabase.from("alerts").insert({
      alert_type,
      severity: cfg.severity.replace(/[^A-Z]/g, ""),
      context,
      sent_to: FOUNDER_EMAIL,
      email_id: emailData.id || null,
      email_status: emailRes.ok ? "sent" : "failed",
      ...(emailRes.ok ? {} : { context: { ...context, resend_error: emailData } }),
    });

    return new Response(JSON.stringify({
      success: true,
      alert_type,
      email_sent: emailRes.ok,
      email_id: emailData.id || null,
    }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("alert-founder error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});