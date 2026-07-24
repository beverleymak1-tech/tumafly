import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("REFUND_NOTIFICATION_WEBHOOK_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-webhook-secret",
};

// ── Support contact (mirrors send-confirmation) ──────────────────────────
const SUPPORT_WHATSAPP = "+254 113 165 503";
const SUPPORT_WHATSAPP_LINK = "https://wa.me/254113165503";
const SUPPORT_EMAIL    = "support@tumafly.com";
const SUPPORT_HOURS    = "Mon–Sun, 8am–8pm EAT";

// ── Design tokens (mirror send-confirmation) ─────────────────────────────
const BRAND_BLUE = "#3D95F5";
const TEXT_DARK  = "#0f1923";
const TEXT_MED   = "#4a5568";
const TEXT_LITE  = "#8a96a3";
const HAIR       = "#e2e8f0";
const BG_TINT    = "#f4f9ff";
const BG_PAGE    = "#f7f9fc";
const REF_TINT   = "#e8f3ff";

// ── Helpers ──────────────────────────────────────────────────────────────
function formatKes(n: number): string {
  return `KES ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "";
}

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function extractFirstName(contact: any): string {
  if (!contact || typeof contact !== "object") return "there";
  const raw =
    contact.first_name ||
    contact.firstName ||
    (typeof contact.name === "string" ? contact.name.split(" ")[0] : null);
  if (!raw || typeof raw !== "string") return "there";
  const trimmed = raw.trim();
  if (!trimmed) return "there";
  return capitalize(trimmed);
}

// ── Email HTML ───────────────────────────────────────────────────────────
function renderShell({
  headerTagline,
  bodyRows,
}: {
  headerTagline: string;
  bodyRows: string;
}): string {
  const supportLines: string[] = [];
  supportLines.push(`WhatsApp: <a href="${SUPPORT_WHATSAPP_LINK}" style="color:${BRAND_BLUE};text-decoration:none;font-weight:600;">${escapeHtml(SUPPORT_WHATSAPP)}</a>`);
  supportLines.push(`Email: <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:${BRAND_BLUE};text-decoration:none;">${escapeHtml(SUPPORT_EMAIL)}</a>`);
  supportLines.push(`<span style="color:${TEXT_LITE};">${escapeHtml(SUPPORT_HOURS)}</span>`);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TumaFly — ${escapeHtml(headerTagline)}</title>
</head>
<body style="margin:0;padding:0;background:${BG_PAGE};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG_PAGE};padding:32px 12px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- HEADER -->
      <tr><td style="background:${BRAND_BLUE};border-radius:14px 14px 0 0;padding:24px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">✈ TumaFly</div>
        <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:4px;">${escapeHtml(headerTagline)}</div>
      </td></tr>

      ${bodyRows}

      <!-- SUPPORT -->
      <tr><td style="background:${BG_TINT};padding:18px 24px;border-bottom:1px solid ${HAIR};">
        <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Need Help?</div>
        <div style="font-size:13px;color:${TEXT_MED};line-height:1.7;">
          ${supportLines.join("<br>")}
        </div>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:18px 24px;text-align:center;">
        <div style="font-size:12px;color:${TEXT_LITE};line-height:1.6;">
          TumaFly · Nairobi, Kenya<br>
          Tuma Labs Limited &nbsp;·&nbsp; Regulated by KCAA &amp; ODPC
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function renderReferenceBlock(label: string, ref: string, subtext?: string): string {
  return `<tr><td style="background:#ffffff;padding:24px;text-align:center;border-bottom:1px solid ${HAIR};">
    <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">${escapeHtml(label)}</div>
    <div style="display:inline-block;background:${REF_TINT};color:${BRAND_BLUE};font-family:'Courier New',monospace;font-size:22px;font-weight:700;padding:10px 24px;border-radius:8px;letter-spacing:2px;">${escapeHtml(ref)}</div>
    ${subtext ? `<div style="font-size:13px;color:${TEXT_LITE};margin-top:10px;">${escapeHtml(subtext)}</div>` : ""}
  </td></tr>`;
}

function renderAmountBlock(label: string, amountLabel: string): string {
  return `<tr><td style="background:#ffffff;padding:20px 24px;border-bottom:1px solid ${HAIR};text-align:center;">
    <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">${escapeHtml(label)}</div>
    <div style="font-size:26px;color:${BRAND_BLUE};font-weight:700;letter-spacing:-0.3px;">${escapeHtml(amountLabel)}</div>
  </td></tr>`;
}

function renderProseBlock(label: string, htmlContent: string): string {
  return `<tr><td style="background:#ffffff;padding:18px 24px;border-bottom:1px solid ${HAIR};">
    <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">${escapeHtml(label)}</div>
    <div style="font-size:14px;color:${TEXT_MED};line-height:1.6;">${htmlContent}</div>
  </td></tr>`;
}

function renderGreetingBlock(greeting: string): string {
  return `<tr><td style="background:#ffffff;padding:20px 24px 6px 24px;">
    <div style="font-size:15px;color:${TEXT_DARK};font-weight:600;">${escapeHtml(greeting)}</div>
  </td></tr>`;
}

// ── Initiated branch ─────────────────────────────────────────────────────
function buildInitiatedEmail(
  { firstName, amountLabel, tfRef, pnr }:
  { firstName: string; amountLabel: string; tfRef: string; pnr: string | null }
) {
  const subject = `Your TumaFly refund is on the way — ${tfRef}`;

  const bodyRows = [
    renderGreetingBlock(`Hi ${firstName},`),
    renderProseBlock(
      "About your refund",
      `We weren't able to complete your ticket booking with the airline, so we've started a refund to the payment method you used.`
    ),
    renderAmountBlock("Refund amount", amountLabel),
    renderReferenceBlock("Booking reference", tfRef, pnr ? `Airline reference: ${pnr}` : undefined),
    renderProseBlock(
      "When you'll see it",
      `<div style="margin-bottom:8px;">Card refunds typically settle in <strong style="color:${TEXT_DARK};">3–5 business days</strong>.</div>
       <div>M-Pesa refunds settle in <strong style="color:${TEXT_DARK};">5–10 business days</strong>.</div>`
    ),
    renderProseBlock(
      "We're sorry",
      `Sorry for the disruption. If you have any questions, message us on WhatsApp or reply to this email — we usually respond within a few hours.`
    ),
  ].join("");

  const html = renderShell({
    headerTagline: "Your refund is on the way",
    bodyRows,
  });

  const pnrLine = pnr ? `Airline reference: ${pnr}\n` : "";
  const text = `Hi ${firstName},

We weren't able to complete your ticket booking with the airline, so we've started a refund of ${amountLabel} to the payment method you used.

Card refunds typically settle in 3–5 business days. M-Pesa refunds settle in 5–10 business days.

Booking reference: ${tfRef}
${pnrLine}
If you have any questions, message us on WhatsApp at ${SUPPORT_WHATSAPP} or reply to this email.

Sorry for the disruption.

The TumaFly team
${SUPPORT_EMAIL}`;

  return { subject, html, text };
}

// ── Settled branch ───────────────────────────────────────────────────────
function buildSettledEmail(
  { firstName, amountLabel, tfRef }:
  { firstName: string; amountLabel: string; tfRef: string }
) {
  const subject = `Your TumaFly refund has settled — ${tfRef}`;

  const bodyRows = [
    renderGreetingBlock(`Hi ${firstName},`),
    renderProseBlock(
      "Refund confirmed",
      `Just confirming — your refund has now been processed on our end. It should be visible on your statement, or shortly will be.`
    ),
    renderAmountBlock("Refund amount", amountLabel),
    renderReferenceBlock("Booking reference", tfRef),
    renderProseBlock(
      "If anything looks off",
      `Message us on WhatsApp and we'll dig in. Thanks for your patience.`
    ),
  ].join("");

  const html = renderShell({
    headerTagline: "Your refund has settled",
    bodyRows,
  });

  const text = `Hi ${firstName},

Just confirming — the ${amountLabel} refund for booking ${tfRef} has now been processed on our end. It should be visible on your statement, or shortly will be.

If you don't see it, or if anything else looks off, message us on WhatsApp at ${SUPPORT_WHATSAPP} and we'll dig in.

Thanks for your patience.

The TumaFly team
${SUPPORT_EMAIL}`;

  return { subject, html, text };
}

// ── HTTP handler ─────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const providedSecret = req.headers.get("x-webhook-secret");
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    console.error("send-refund-notification: unauthorized");
    return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  try {
    const payload = await req.json();
    const { type, record, old_record } = payload;

    if (!record || !record.id) {
      return new Response("no record", { status: 200, headers: CORS_HEADERS });
    }

    let branch: "initiated" | "settled" | null = null;
    if (type === "INSERT" && record.status === "pending") {
      branch = "initiated";
    } else if (
      type === "UPDATE" &&
      old_record?.status === "pending" &&
      record.status === "processed"
    ) {
      branch = "settled";
    }
    if (!branch) {
      return new Response("no-op event", { status: 200, headers: CORS_HEADERS });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const sentColumn = branch === "initiated"
      ? "refund_notification_sent_at"
      : "refund_settled_notification_sent_at";

    const { data: refund, error: refundErr } = await sb
      .from("refunds")
      .select(`
        id,
        pending_booking_id,
        merchant_ref,
        amount_kes,
        status,
        customer_email,
        refund_notification_sent_at,
        refund_settled_notification_sent_at
      `)
      .eq("id", record.id)
      .single();

    if (refundErr || !refund) {
      console.error("send-refund-notification: refund fetch failed", refundErr);
      return new Response("refund not found", { status: 200, headers: CORS_HEADERS });
    }

    if ((refund as any)[sentColumn]) {
      return new Response(`already sent (${branch})`, { status: 200, headers: CORS_HEADERS });
    }

    const to = refund.customer_email;
    if (!to) {
      console.error("send-refund-notification: no customer_email on refund", refund.id);
      return new Response("no recipient", { status: 200, headers: CORS_HEADERS });
    }

    const { data: pb } = await sb
      .from("pending_bookings")
      .select("contact, booking_reference")
      .eq("id", refund.pending_booking_id)
      .single();

    const firstName = extractFirstName(pb?.contact);
    const tfRef = refund.merchant_ref || "—";
    const pnr = pb?.booking_reference || null;
    const amountLabel = formatKes(refund.amount_kes);

    const { subject, html, text } = branch === "initiated"
      ? buildInitiatedEmail({ firstName, amountLabel, tfRef, pnr })
      : buildSettledEmail({ firstName, amountLabel, tfRef });

    if (!RESEND_API_KEY) {
      console.error("send-refund-notification: RESEND_API_KEY missing");
      return new Response("mail config error", { status: 500, headers: CORS_HEADERS });
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TumaFly <bookings@tumafly.com>",
        to: [to],
        reply_to: "support@tumafly.com",
        subject,
        html,
        text,
        tags: [
          { name: "kind", value: `refund_${branch}` },
          { name: "refund_id", value: refund.id },
        ],
      }),
    });

    if (!resendRes.ok) {
      const body = await resendRes.text();
      console.error("send-refund-notification: resend failed", resendRes.status, body);
      return new Response(`resend failed: ${resendRes.status}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const { error: updateErr } = await sb
      .from("refunds")
      .update({ [sentColumn]: new Date().toISOString() })
      .eq("id", refund.id);

    if (updateErr) {
      console.error("send-refund-notification: mark-sent failed", updateErr);
    }

    return new Response(`sent (${branch})`, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("send-refund-notification: unhandled", e);
    return new Response("error", { status: 500, headers: CORS_HEADERS });
  }
});