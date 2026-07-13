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
  | "PAID_NO_OFFER"                        // customer paid, Duffel offer expired before we could book
  | "PAID_NO_TICKET"                       // customer paid, Duffel rejected the booking
  | "BOOKED_NO_DB_RECORD"                  // ticket issued but our DB write failed
  | "AMOUNT_MISMATCH"                      // processor reported a different amount than expected
  | "PAYMENT_FAILED"                       // payment didn't complete (informational only)
  | "UNHANDLED_ERROR"                      // webhook crashed
  // Batch 2 refund automation (Session 25)
  | "REFUND_DB_INSERT_FAILED"              // refundBooking() couldn't insert refunds row (non-duplicate)
  | "REFUND_API_FAILED"                    // Paystack /refund non-2xx
  | "REFUND_UNHANDLED_ERROR"               // try/catch in refundBooking()
  | "REFUND_EVENT_MISSING_IDS"             // refund webhook with no id or transaction
  | "REFUND_EVENT_NO_ROW"                  // refund webhook for row we didn't create (manual/dashboard-initiated)
  | "REFUND_FAILED"                        // Paystack refund.failed event fired
  // Paystack webhook plumbing alerts (Session 20/25 wiring)
  | "PAYSTACK_MALFORMED_WEBHOOK"           // JSON parse failed on webhook payload
  | "PAYSTACK_SIGNATURE_FAILURE"           // HMAC-SHA512 mismatch on webhook
  | "PAYSTACK_MISSING_REFERENCE"           // charge.success with no reference
  | "PAYSTACK_OR_DUFFEL_MODE_KEY_MISMATCH" // mode/key mismatch in paystack-webhook
  | "PAYSTACK_MODE_KEY_MISMATCH";          // mode/key mismatch in verify-payment

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
    // ── Batch 2 refund automation (Session 25) ──────────────────────────────
    REFUND_DB_INSERT_FAILED: {
      severity: "🚨 CRITICAL",
      subject: "Automated refund could not be recorded in DB",
      action: "refundBooking() failed to write to refunds table BEFORE calling Paystack. Customer's payment is captured, no refund has been issued. Refund manually via Paystack dashboard, then INSERT the refunds row, then UPDATE pending_bookings.status='refunded'.",
    },
    REFUND_API_FAILED: {
      severity: "🚨 CRITICAL",
      subject: "Paystack refund API rejected our request",
      action: "refunds row exists but Paystack /refund returned non-2xx. Check paystack_error field on the refunds row for details. Refund manually via Paystack dashboard, then UPDATE refunds row with paystack_refund_id + status='pending'.",
    },
    REFUND_UNHANDLED_ERROR: {
      severity: "🚨 CRITICAL",
      subject: "Unhandled exception in refundBooking()",
      action: "Something threw inside the refund helper. Check stack trace. Customer state unclear — verify pending_bookings.status and refunds table by hand, refund manually if needed.",
    },
    REFUND_EVENT_MISSING_IDS: {
      severity: "⚠️ HIGH",
      subject: "Paystack refund webhook missing id/transaction",
      action: "A refund event arrived with neither a refund id nor a transaction id. Likely a Paystack payload change. Check paystack-webhook logs for the raw payload.",
    },
    REFUND_EVENT_NO_ROW: {
      severity: "ℹ️ INFO",
      subject: "Paystack refund event for unknown refund",
      action: "A refund event fired for a refund not initiated by refundBooking() (typically a manual refund from Paystack dashboard). Expected for manual refunds; reconcile if unexpected.",
    },
    REFUND_FAILED: {
      severity: "🚨 CRITICAL",
      subject: "Paystack refund.failed event fired",
      action: "Paystack rejected the refund it initially accepted. pending_bookings stuck at refund_pending. Investigate the refund_id in Paystack dashboard, resolve with customer, then update DB.",
    },
    // ── Paystack webhook plumbing (Session 20/25) ───────────────────────────
    PAYSTACK_MALFORMED_WEBHOOK: {
      severity: "⚠️ HIGH",
      subject: "Paystack webhook body was not valid JSON",
      action: "Something upstream is sending malformed payloads. Check paystack-webhook logs. If ongoing, contact Paystack support.",
    },
    PAYSTACK_SIGNATURE_FAILURE: {
      severity: "🚨 CRITICAL",
      subject: "Paystack webhook signature verification failed",
      action: "Either a bad-actor request OR a signing secret mismatch. Confirm PAYSTACK_API_KEY in env vars matches the key Paystack dashboard is signing with. If keys are correct, treat as attempted attack.",
    },
    PAYSTACK_MISSING_REFERENCE: {
      severity: "🚨 CRITICAL",
      subject: "Paystack charge.success with no reference",
      action: "Payment came through but we can't match it to a merchant_ref. Paystack tx_id is in the alert context. Manually reconcile via Paystack dashboard.",
    },
    PAYSTACK_OR_DUFFEL_MODE_KEY_MISMATCH: {
      severity: "🚨 CRITICAL",
      subject: "Environment key/mode mismatch in paystack-webhook",
      action: "DUFFEL_MODE or PAYSTACK_MODE doesn't match the corresponding API key prefix. All requests refused with 503. Fix env vars in Supabase dashboard.",
    },
    PAYSTACK_MODE_KEY_MISMATCH: {
      severity: "🚨 CRITICAL",
      subject: "Environment key/mode mismatch in verify-payment",
      action: "PAYSTACK_MODE doesn't match the PAYSTACK_API_KEY prefix. All verify-payment requests refused with 503. Fix env vars in Supabase dashboard.",
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