import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { redactForEmail, redactForAudit } from "../_shared/redact.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FOUNDER_EMAIL = Deno.env.get("FOUNDER_EMAIL")!; // e.g. founder@tumafly.com
const FOUNDER_NAME = Deno.env.get("FOUNDER_NAME") || "TumaFly Founder";

// Module-scope Supabase client (S-34 cleanup — was instantiated per-request).
// Reused across handler invocations within the same Edge Function isolate.
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

type AlertType =
  | "PAID_NO_OFFER"                        // customer paid, Duffel offer expired before we could book
  | "PAID_NO_TICKET"                       // customer paid, Duffel rejected the booking
  | "BOOKED_NO_DB_RECORD"                  // ticket issued but our DB write failed
  | "AMOUNT_MISMATCH"                      // processor reported a different amount than expected
  | "PRICE_DRIFT"                          // Duffel offer price shifted >1% between search and payment init; customer prompted to re-confirm at new price
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
  | "PAYSTACK_MODE_KEY_MISMATCH"           // mode/key mismatch in verify-payment
  // Duffel-touching EFs outside the main Paystack path (mpesa-callback, get-baggage-options)
  // Session 28b audit: was raised for months, never in the whitelist —
  // silently dropped on every fire. Adding now to close the visibility gap.
  | "DUFFEL_MODE_KEY_MISMATCH"             // mode/key mismatch in mpesa-callback or get-baggage-options
  // Async Duffel decoupling (Session 28b commit #7b-ii)
  | "PROCESS_DUFFEL_PENDING_NOT_FOUND"     // DB webhook fired for a pending row that no longer exists
  | "PROCESS_DUFFEL_PAYSTACK_VERIFY_MISMATCH" // Paystack verify disagreed post-payment (soft-degrade)
  | "PROCESS_DUFFEL_NETWORK_ERROR"         // Duffel POST /air/orders threw (network/timeout/DNS)
  | "PROCESS_DUFFEL_UNHANDLED_ERROR"       // try/catch at handler top in process-duffel-booking
  | "DUFFEL_ORDER_ACCEPTED_ASYNC"          // Duffel 202 — rare, informational, reconciler will finish
  | "CONFIRMATION_EMAIL_FAILED"            // send-confirmation returned non-2xx or threw; reconciler retries
  // S-06 chargeback lifecycle (Paystack dispute events) ──────────────────
  | "CHARGEBACK_OPENED"                    // charge.dispute.create — new dispute filed by customer's bank
  | "CHARGEBACK_REMINDER"                  // charge.dispute.remind — Paystack reminder, response deadline near
  | "CHARGEBACK_RESOLVED_WON"              // charge.dispute.resolve — outcome merchant-won, funds stay with us
  | "CHARGEBACK_RESOLVED_LOST"             // charge.dispute.resolve — outcome merchant-lost, funds pulled back
  // S-07 OTP throttle enforcement (per-IP in otp-precheck EF; per-phone in send-otp EF)
  | "OTP_THROTTLE_HIT"                     // OTP request rate limit exceeded (per-phone 3/15min or 10/24h OR per-IP 10/15min)
  // S-34 cleanup: send-otp legacy alerts migrated to typed contract
  | "OTP_DELIVERY_FAILED"                  // Africa's Talking HTTP request failed (network/500/timeout); OTP not sent
  | "OTP_STATUS_NON_SUCCESS"               // AT accepted request but returned non-Success for individual recipient; OTP undelivered
  // S-11 guest-token brute-force threshold (mint-guest-token EF)
  | "GUEST_TOKEN_ATTEMPT_THRESHOLD"        // pending_bookings.guest_token_attempts crossed MAX_ATTEMPTS (20) on this request
  // Session 39 heartbeat monitoring — customer-money-taken rows stuck past
  // SLA AND cron auth health checks. Complements per-EF alerts by catching
  // silent failures where no EF ever runs to send its own alert (the class
  // of failure that hid the retry-stuck-bookings vault-placeholder P0 for
  // probably months). See session_s39_heartbeat_infra.sql for full context.
  | "HEARTBEAT_STUCK_ROWS"                 // one or more pending_bookings rows past 15min in customer-money-taken non-terminal state
  | "HEARTBEAT_CRON_FAILURES"              // non-2xx/timeout/error responses from pg_net HTTP callers in trailing 60min
  | "UNKNOWN_ALERT_TYPE";                  // S-02 fallback — unregistered alert_type received, rendered synthetically to avoid silent-drop

const ALERT_CONFIG: Record<AlertType, { severity: string; subject: string; action: string; dedup_cooldown_minutes?: number }> = {
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
    subject: "Payment amount does not match expected total",
    action: "Investigate. May indicate tampering or a processor bug. Contact customer to confirm.",
  },
  PRICE_DRIFT: {
    severity: "ℹ️ INFO",
    subject: "Duffel offer price drifted >1% at payment init — customer prompted to re-confirm",
    action: "Individual fires are normal (Duffel fare updates between search and booking). Frontend has returned 409 PRICE_DRIFT to the customer; they re-confirm at the new price or abandon. Investigate only on sustained patterns: many fires within a short window (Duffel-side pricing turbulence) OR repeats on same offer_id (frontend cache staleness OR user retry loops). Baseline expectation ~0.5-2% of initialize-payment calls under normal Duffel conditions; anomalous >5% sustained warrants Duffel Support ticket. Query: SELECT date_trunc('hour', created_at), COUNT(*) FROM alerts WHERE alert_type='PRICE_DRIFT' GROUP BY 1 ORDER BY 1 DESC LIMIT 24;",
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
        // ── Duffel-touching EFs outside the main Paystack path (Session 28b audit gap-fill) ──
        DUFFEL_MODE_KEY_MISMATCH: {
          severity: "🚨 CRITICAL",
          subject: "Environment key/mode mismatch in mpesa-callback or get-baggage-options",
          action: "DUFFEL_MODE doesn't match one or both of DUFFEL_READ_KEY / DUFFEL_WRITE_KEY prefixes (post-Session-35b split), OR the legacy DUFFEL_API_KEY fallback used by an unmigrated EF. All calls to that EF refused with 503. Fix env vars in Supabase dashboard: DUFFEL_READ_KEY + DUFFEL_WRITE_KEY should both start with `duffel_test_` when DUFFEL_MODE=sandbox, `duffel_live_` when DUFFEL_MODE=production.",
        },
        // ── Async Duffel decoupling (Session 28b commit #7b-ii) ─────────────────
        PROCESS_DUFFEL_PENDING_NOT_FOUND: {
          severity: "⚠️ HIGH",
          subject: "process-duffel-booking fired for missing pending_booking row",
          action: "DB webhook fired with a pending_booking_id that no longer exists in the pending_bookings table. Either the row was deleted between transition and this EF's read (unusual — check for admin action), or the webhook payload is malformed. Check the pending_booking_id in context and reconcile against the row's history in booking_status_history.",
        },
        PROCESS_DUFFEL_PAYSTACK_VERIFY_MISMATCH: {
          severity: "⚠️ HIGH",
          subject: "Paystack verify disagreed post-payment in process-duffel-booking",
          action: "Paystack's /transaction/verify endpoint returned a non-success state for a transaction that paystack-webhook had already confirmed. Booking continued (soft-degrade) with NULL authorization_code and payment_account_last4 on the bookings row. Investigate whether the transaction is a Paystack timeline anomaly or an actual state divergence. Manual reconciliation may be needed if payment was reversed.",
        },
        PROCESS_DUFFEL_NETWORK_ERROR: {
          severity: "⚠️ HIGH",
          subject: "Duffel POST /air/orders network error",
          action: "process-duffel-booking's Duffel call threw (network/timeout/DNS). Row stays at duffel_pending — DB webhook will retry. If this fires repeatedly for the same row, Duffel or our egress is degraded. Duffel-Idempotency-Key ensures retries won't create duplicates.",
        },
        PROCESS_DUFFEL_UNHANDLED_ERROR: {
          severity: "🚨 CRITICAL",
          subject: "Unhandled exception in process-duffel-booking",
          action: "The top-level try/catch in process-duffel-booking fired. Row is likely stuck at duffel_pending. Check logs for the stack trace. Manually inspect the pending_booking_id in context and, if it's still at duffel_pending, either fix the underlying error and let the DB webhook retry, or move it to paid_booking_failed manually and refund via refundBooking().",
        },
        DUFFEL_ORDER_ACCEPTED_ASYNC: {
          severity: "ℹ️ INFO",
          subject: "Duffel returned 202 async accepted",
          action: "Rare with type:instant — Duffel accepted the order but hasn't created it synchronously. Row stays at duffel_pending. retry-stuck-bookings (#9) will poll GET /air/orders?duffel_idempotency_key={pending.id} and complete the transition. No action needed unless it stays stuck > 10 minutes.",
        },
        CONFIRMATION_EMAIL_FAILED: {
          severity: "⚠️ HIGH",
          subject: "send-confirmation returned non-2xx or threw",
          action: "Booking is safe — customer is 'booked' in DB and at Duffel. Only the confirmation email failed. retry-stuck-bookings (#9) sweeps 'booked' rows with NULL confirmation_email_sent_at and retries. If this fires more than once for the same row, investigate send-confirmation and RESEND_API_KEY. Customer will not have their e-ticket until email delivers — WhatsApp them their PNR + ticket numbers if 15+ minutes have passed since booking.",
        },
        // ── S-06 chargeback lifecycle (Paystack dispute events) ────────────────
        CHARGEBACK_OPENED: {
          severity: "🚨 CRITICAL",
          subject: "Chargeback opened — customer disputed a payment",
          action: "Customer's bank filed a chargeback. Response deadline is typically 7-14 days depending on card scheme. Check prior_status + flown fields in context: (a) prior_status='confirmed' + flown=false = normal in-flight booking dispute, gather evidence (booking record, comms, PNR); (b) prior_status='confirmed' + flown=true = FRIENDLY FRAUD (customer flew then disputed), high-priority; (c) prior_status != 'confirmed' = PRE-EXISTING CANCEL STATE, potential double-loss, investigate immediately. Respond via Paystack dashboard → Disputes.",
        },
        CHARGEBACK_REMINDER: {
          severity: "⚠️ HIGH",
          subject: "Chargeback response deadline approaching",
          action: "Paystack has re-notified us that a dispute response is still outstanding. Deadline is typically 48-72 hours away. If we haven't responded yet, drop everything — miss the deadline and the dispute auto-loses. Respond via Paystack dashboard → Disputes.",
        },
        CHARGEBACK_RESOLVED_WON: {
          severity: "ℹ️ INFO",
          subject: "Chargeback resolved — merchant won",
          action: "Dispute closed in our favor. Funds stay with us. Booking transitioned to chargeback_won (internal state; customer-facing UX unchanged from confirmed). No action required — log for records.",
        },
        CHARGEBACK_RESOLVED_LOST: {
                  severity: "🚨 CRITICAL",
                  subject: "Chargeback resolved — merchant lost, funds pulled back",
                  action: "Dispute closed against us. Paystack has withdrawn the disputed amount. Booking transitioned to chargeback_lost. Check flown field: (a) flown=false = ticket still valid at Duffel, consider cancelling via Duffel dashboard to avoid double-loss (no refund from airline but frees the seat); (b) flown=true = friendly fraud, no recovery path, add customer to internal block-list for future consideration. Check prior_status: if != 'confirmed', this is a double-loss (we refunded AND lost the chargeback), escalate.",
                },
                // ── S-07 OTP throttle enforcement (per-IP from otp-precheck; per-phone from send-otp) ──
                        OTP_THROTTLE_HIT: {
                          severity: "⚠️ WARN",
                          subject: "OTP throttle hit — possible abuse",
                          action: "Rate limit exceeded on OTP requests. Check context for scope (phone or ip) and scope_value_sha256. If ip scope: could be benign burst (shared NAT, corporate proxy) OR bot probing — check otp_attempts table for pattern and adjacent phone activity. If phone scope: possible SMS-bomb targeting a specific user — check if hash matches a real user via SELECT encode(digest(phone,'sha256'),'hex') FROM auth.users. If pattern persists or targets a real user, add IP to Cloudflare WAF block list (S-13) or reach out to affected user via WhatsApp fallback.",
                          dedup_cooldown_minutes: 60,  // one alert per scope_value per hour
                        },
                        // ── S-34 cleanup: send-otp AT delivery-failure alerts (migrated from legacy alertFounder helper) ──
                        OTP_DELIVERY_FAILED: {
                          severity: "⚠️ HIGH",
                          subject: "OTP SMS delivery failed at Africa's Talking",
                          action: "Africa's Talking API returned non-2xx for an OTP send request. Customer did NOT receive their OTP; they'll be stuck at the sign-in screen. Check context: phone_sha256, at_http_status, at_message. If at_http_status is 5xx: likely AT outage — check status.africastalking.com. If 4xx: likely AT_API_KEY or account-balance issue — check AT dashboard for account balance + key validity. If pattern persists, reach out to affected user via WhatsApp fallback with a magic-link workaround (currently manual — future enhancement in send-otp).",
                          // No dedup — each failure is distinct + intermittent; want visibility on all.
                        },
                        OTP_STATUS_NON_SUCCESS: {
                          severity: "⚠️ HIGH",
                          subject: "OTP send succeeded but AT reported per-recipient failure",
                          action: "AT accepted the OTP send request but returned a non-Success status for one or more recipients. Customer may not have received their OTP. Check context: phone_sha256, at_status_code, at_message. Common at_status_code values: 401 (invalid number format), 402 (insufficient AT credit — TOP UP), 403 (blacklisted by carrier). If credit-related, top up AT account at dashboard.africastalking.com immediately. If number-related, reach out to affected user via WhatsApp fallback.",
                          // No dedup — each failure is distinct + intermittent.
                        },
                        // ── S-11 guest-token brute-force threshold (mint-guest-token) ──
                        GUEST_TOKEN_ATTEMPT_THRESHOLD: {
                          severity: "⚠️ HIGH",
                          subject: "Guest-token brute-force threshold reached",
                          action: "A pending_bookings row's guest_token_attempts counter crossed MAX_ATTEMPTS (20). All subsequent mint-guest-token requests for this booking will 429 until counter is reset. Check context: pending_booking_id (safe to log), attempt_count, source_ip_hash. Investigate: SELECT id, user_id, guest_pending_booking_id, status, created_at FROM pending_bookings WHERE id = '{pending_booking_id}'. If the affected booking is a real customer's, contact them via their auth.users email and ask if they hit the resend link repeatedly. If suspicious pattern (multiple bookings from same source_ip_hash), add IP to Cloudflare WAF block list (S-13). To unblock a legitimate customer: UPDATE pending_bookings SET guest_token_attempts = 0 WHERE id = '{pending_booking_id}'.",
                          dedup_cooldown_minutes: 60,  // dedup per pending_booking_id per hour (mechanic naturally fires once, dedup is defensive)
                        },
                        // ── Session 39 heartbeat monitoring ─────────────────────────────────────
                        HEARTBEAT_STUCK_ROWS: {
                          severity: "🚨 CRITICAL",
                          subject: "Heartbeat: pending_bookings rows stuck past SLA",
                          action: "Rows have been in customer-money-taken non-terminal states (paid, booking, duffel_pending, pnr_issued, paid_offer_expired, paid_booking_failed, refund_pending) for >15 min. Normal machinery (process-duffel-booking + retry-stuck-bookings cron + refund executor) should have resolved these by now. Investigate: (1) check cron.job_run_details and net._http_response for recent 4xx/5xx; (2) inspect each row's booking_status_history to see where the transition chain stopped; (3) if reconciler misclassified as orphan (duffel_pending_orphan_alert_only), verify against Duffel dashboard before force-refunding. Full row context in the alert payload. See session_s39_heartbeat_infra.sql.",
                          dedup_cooldown_minutes: 30,
                        },
                        HEARTBEAT_CRON_FAILURES: {
                          severity: "🚨 CRITICAL",
                          subject: "Heartbeat: pg_net HTTP callers returning failures",
                          action: "One or more pg_net HTTP calls (from pg_cron jobs) returned non-2xx / timed out / errored in the trailing 60 min. This is the exact class of silent failure that hid the retry-stuck-bookings vault-placeholder P0 for probably months. Investigate: (1) query `SELECT * FROM net._http_response WHERE created > NOW() - INTERVAL '2 hours' AND (status_code >= 400 OR timed_out OR error_msg IS NOT NULL) ORDER BY created DESC;` to see the full failure detail; (2) map back to which cron job originated each request (join on cron.job_run_details.start_time ≈ net._http_response.created); (3) if 401, check the auth mechanism used by that cron — most likely a vault entry drift. Fix per SOP §1 (Secret Rotation). See session_s39_heartbeat_infra.sql.",
                          dedup_cooldown_minutes: 30,
                        },
                // ── S-02 fallback: unregistered alert types render here (never silently dropped) ──
        UNKNOWN_ALERT_TYPE: {
          severity: "🟡 UNKNOWN",
          subject: "Unregistered alert type received",
          action: "This alert_type is not registered in alert-founder's whitelist. Redacted payload attached. Add the type to the AlertType union + ALERT_CONFIG in supabase/functions/alert-founder/index.ts, then redeploy.",
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
      const { alert_type, context, dedup_key: providedDedupKey } = await req.json();

    // Hard-guard: alert_type must be present. Empty is a caller bug, not an
    // unknown-type (which S-02 now handles gracefully below).
    if (!alert_type) {
      return new Response(JSON.stringify({ error: "Missing alert_type" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Session 35b Architecture B: split redaction paths.
    //   emailContext — PII + SECRETS scrubbed (outbound to Resend + inbox)
    //   auditContext — SECRETS only (raw PII preserved for §26 access,
    //                  RTBF Stage 4, and forensic reconstruction; the
    //                  alerts table is inside the trust boundary — RLS
    //                  deny-all + service-role-only + 365d retention).
    // See TumaFly_Session35b_Design_Audit.md §2.1-3.
    const rawContext = (context || {}) as Record<string, unknown>;
    const emailContext = redactForEmail(rawContext) as Record<string, unknown>;
    const auditContext = redactForAudit(rawContext) as Record<string, unknown>;

    // S-02: UNKNOWN_ALERT_TYPE fallback. Previous behaviour was HTTP 400 on
    // unregistered types — silently dropped. Now: render synthetically so
    // operators see the unknown type and can add it to the whitelist.
    const isKnown = !!ALERT_CONFIG[alert_type as AlertType];
    const effectiveType: AlertType = isKnown
      ? (alert_type as AlertType)
      : "UNKNOWN_ALERT_TYPE";

    // Preserve which unknown type came in so operators can trace the caller.
    // Applied to both paths so email + audit both surface the received type.
    const contextForEmail = isKnown
      ? emailContext
      : { received_alert_type: alert_type, ...emailContext };
    const contextForAudit = isKnown
      ? auditContext
      : { received_alert_type: alert_type, ...auditContext };

    const cfg = ALERT_CONFIG[effectiveType];

        // ── S-07c-alerts: dedup check ────────────────────────────────────────────
        // Effective dedup_key: caller-provided > default = null (no dedup).
        // Dedup only engages if cfg.dedup_cooldown_minutes IS set AND we have a
        // dedup_key. Audit row is inserted either way (compliance, dashboarding).
        // Note: `supabase` is the module-scope singleton declared at top of file.
        const effectiveDedupKey: string | null = providedDedupKey || null;
        let suppressed = false;
        let suppressionReason: string | null = null;

        if (cfg.dedup_cooldown_minutes && effectiveDedupKey) {
          const windowStart = new Date(Date.now() - cfg.dedup_cooldown_minutes * 60 * 1000).toISOString();
          const { data: recent, error: dedupErr } = await supabase
            .from("alerts")
            .select("id")
            .eq("alert_type", effectiveType)
            .eq("dedup_key", effectiveDedupKey)
            .gte("created_at", windowStart)
            .limit(1);
          if (dedupErr) {
            console.error("[alert-founder] dedup query failed (proceeding):", dedupErr.message);
            // Fail-open on dedup query error: fire the email anyway (don't miss a real alert).
          } else if (recent && recent.length > 0) {
            suppressed = true;
            suppressionReason = "cooldown_active";
            console.log(`[alert-founder] SUPPRESSED (cooldown): type=${effectiveType} dedup_key=${effectiveDedupKey}`);
          }
        }

        // ── Dispatch (only if not suppressed) ────────────────────────────────────
        let emailRes: Response | null = null;
        let emailData: { id?: string; [k: string]: unknown } = {};

        if (!suppressed) {
          const html = buildEmailHtml(effectiveType, contextForEmail);
          emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "TumaFly Alerts <alerts@tumafly.com>",
              to: [FOUNDER_EMAIL],
              subject: isKnown ? `${cfg.severity} ${cfg.subject}` : `${cfg.severity} ${cfg.subject} — ${alert_type}`,
              html,
            }),
          });
          emailData = await emailRes.json();
          if (!emailRes.ok) {
          console.error(`Resend email failed: status=${emailRes?.status} name=${emailData?.name || "unknown"}`);
          }
        }

        // ── Audit insert (ALWAYS — dedup metadata + delivery outcome) ────────────
        // Session 35b: audit row uses contextForAudit (PII preserved, secrets stripped).
        // resend_error is defensively passed through redactForAudit in case Resend
        // ever echoes a credential-shaped field in its error responses.
        const emailStatus = suppressed
          ? "suppressed"
          : (emailRes?.ok ? "sent" : "failed");
        const insertContext = suppressed
          ? contextForAudit
          : (emailRes?.ok
              ? contextForAudit
              : { ...contextForAudit, resend_error: redactForAudit(emailData) });

        await supabase.from("alerts").insert({
          alert_type:         effectiveType,
          severity:           cfg.severity.replace(/[^A-Z]/g, ""),
          context:            insertContext,
          sent_to:            FOUNDER_EMAIL,
          email_id:           emailData.id || null,
          email_status:       emailStatus,
          dedup_key:          effectiveDedupKey,
          suppressed:         suppressed,
          suppression_reason: suppressionReason,
        });

        return new Response(JSON.stringify({
          success:      true,
          alert_type,
          email_sent:   !suppressed && !!emailRes?.ok,
          suppressed:   suppressed,
          suppression_reason: suppressionReason,
          email_id:     emailData.id || null,
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