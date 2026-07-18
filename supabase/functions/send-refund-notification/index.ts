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

const SUPPORT_WHATSAPP = "+254 798 836 069";
const SUPPORT_WHATSAPP_LINK = "https://wa.me/254798836069";
const SUPPORT_EMAIL = "support@tumafly.com";
const FROM_ADDRESS = "TumaFly <bookings@tumafly.com>";
const REPLY_TO = "support@tumafly.com";

function formatKes(n: number): string {
  return `KES ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
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
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Shared-secret auth. DB webhook must include x-webhook-secret header.
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

    // Which email (if any) does this event fire?
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

    // Read the LIVE row — payload could be stale on retry.
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

    // Fetch pending_bookings for contact.first_name + PNR.
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
        from: FROM_ADDRESS,
        to: [to],
        reply_to: REPLY_TO,
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
      // 5xx → DB webhook retries.
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
      // Email sent, DB update failed. Log; accept small double-send risk on retry.
      console.error("send-refund-notification: mark-sent failed", updateErr);
    }

    return new Response(`sent (${branch})`, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("send-refund-notification: unhandled", e);
    return new Response("error", { status: 500, headers: CORS_HEADERS });
  }
});

function buildInitiatedEmail(
  { firstName, amountLabel, tfRef, pnr }:
  { firstName: string; amountLabel: string; tfRef: string; pnr: string | null }
) {
  const subject = "Your TumaFly refund is on the way";
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

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;line-height:1.6;color:#111">
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>We weren't able to complete your ticket booking with the airline, so we've started a refund of <strong>${escapeHtml(amountLabel)}</strong> to the payment method you used.</p>
    <p>Card refunds typically settle in 3–5 business days. M-Pesa refunds settle in 5–10 business days.</p>
    <p style="margin:20px 0;padding:12px 16px;background:#f5f5f5;border-radius:6px;font-size:14px">
      <strong>Booking reference:</strong> ${escapeHtml(tfRef)}<br>
      ${pnr ? `<strong>Airline reference:</strong> ${escapeHtml(pnr)}<br>` : ""}
    </p>
    <p>If you have any questions, message us on WhatsApp at <a href="${SUPPORT_WHATSAPP_LINK}">${SUPPORT_WHATSAPP}</a> or reply to this email.</p>
    <p>Sorry for the disruption.</p>
    <p style="margin-top:24px">The TumaFly team<br><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
  </div>`;

  return { subject, html, text };
}

function buildSettledEmail(
  { firstName, amountLabel, tfRef }:
  { firstName: string; amountLabel: string; tfRef: string }
) {
  const subject = "Your TumaFly refund has settled";

  const text = `Hi ${firstName},

Just confirming — the ${amountLabel} refund for booking ${tfRef} has now been processed on our end. It should be visible on your statement, or shortly will be.

If you don't see it, or if anything else looks off, message us on WhatsApp at ${SUPPORT_WHATSAPP} and we'll dig in.

Thanks for your patience.

The TumaFly team
${SUPPORT_EMAIL}`;

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;line-height:1.6;color:#111">
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Just confirming — the <strong>${escapeHtml(amountLabel)}</strong> refund for booking <strong>${escapeHtml(tfRef)}</strong> has now been processed on our end. It should be visible on your statement, or shortly will be.</p>
    <p>If you don't see it, or if anything else looks off, message us on WhatsApp at <a href="${SUPPORT_WHATSAPP_LINK}">${SUPPORT_WHATSAPP}</a> and we'll dig in.</p>
    <p>Thanks for your patience.</p>
    <p style="margin-top:24px">The TumaFly team<br><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
  </div>`;

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}