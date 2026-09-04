// supabase/functions/heartbeat/index.ts
//
// Session 39 — heartbeat EF.
//
// Hourly-invoked (via pg_cron job `heartbeat_hourly`, jobid 7) monitor that
// checks two independent signals and alerts on either. External belt-and-
// braces via healthchecks.io ping catches the case where the heartbeat
// itself can't run.
//
// Signal 1 — Stuck rows
//   Any pending_bookings row in a customer-money-taken non-terminal state
//   (paid, duffel_pending, refund_pending, paid_offer_expired,
//   paid_booking_failed, duffel_pending_orphan_alert_only, needs_support)
//   that hasn't updated in >15 min. Catches: silent auth failures anywhere
//   in the write path, cron silently not executing, reconciler
//   misclassifications, unknown-unknowns.
//
// Signal 2 — Cron auth health
//   Any non-2xx / timeout / error from pg_net HTTP callers in the trailing
//   60 min. Catches: the exact class of silent auth failure that hid the
//   retry-stuck-bookings vault-placeholder P0 for probably months. Cheap
//   to check (single DB call) and generalises to any future cron.
//
// Design decisions (see Session 39 handoff for full rationale):
//   - 15-min stuck threshold: past the 5-min reconciler wall + refund path
//     latency + Paystack refund API. Rows stuck past 15 min mean something
//     outside normal recovery paths broke.
//   - 60-min cron failure window: matches heartbeat cadence.
//   - dedup_key on stuck-rows alert = stable hash of sorted row IDs. If
//     the set of stuck rows changes, new alert. If set persists, one
//     alert per 30 min (per ALERT_CONFIG cooldown).
//   - dedup_key on cron-failures alert = 'cron_failures'. Single dedup
//     bucket. One alert per 30 min while failures persist.
//   - healthchecks.io ping fires only if EF completed all work. A ping
//     means "heartbeat is healthy end-to-end". Absence of ping means
//     either the EF can't run at all or its work errored — both warrant
//     the healthchecks.io alert.
//
// Env vars required:
//   SUPABASE_URL            — auto-injected
//   SERVICE_ROLE_KEY        — custom secret (NOT SUPABASE_SERVICE_ROLE_KEY; see RUNBOOK §1.6)
//   HEALTHCHECKS_PING_URL   — the healthchecks.io ping URL for this check
//
// RUNBOOK cross-refs:
//   §1.1 — config.toml entry required (see supabase/config.toml)
//   §1.6 — SERVICE_ROLE_KEY convention
//   §1.7 — alertFounder .ok check discipline
//   §1.8 — dedup framework — 30min cooldown, explicit dedup_key
//
// See also:
//   supabase/migrations/session_s39_heartbeat_infra.sql — table + function + cron
//   supabase/functions/alert-founder/index.ts — AlertType definitions

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const HEALTHCHECKS_PING_URL = Deno.env.get("HEALTHCHECKS_PING_URL");

// Statuses that mean "customer's money is taken but their booking is not
// yet resolved." List audited against the actual pending_booking_status
// enum values on 2026-09-04 (Session 39 smoke test caught two invalid
// entries from the initial draft — `needs_support` and
// `duffel_pending_orphan_alert_only`, both of which existed only in
// handoff docs, not in the DB enum).
//
// Additions here should be reviewed against:
//   SELECT enumlabel FROM pg_enum WHERE enumtypid = 'pending_booking_status'::regtype;
const MONEY_TAKEN_NON_TERMINAL_STATUSES = [
  "paid",
  "booking",
  "duffel_pending",
  "pnr_issued",
  "paid_offer_expired",
  "paid_booking_failed",
  "refund_pending",
];

const STUCK_THRESHOLD_MINUTES = 15;
const CRON_FAILURE_WINDOW_MINUTES = 60;

// Module-scope client (S-34 cleanup pattern — same as alert-founder).
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────

async function fireAlert(
  alertType: "HEARTBEAT_STUCK_ROWS" | "HEARTBEAT_CRON_FAILURES",
  context: Record<string, unknown>,
  dedupKey: string,
): Promise<{ ok: boolean; status?: number; body?: string }> {
  // Per RUNBOOK §1.7: must check response.ok and log non-2xx. `await fetch`
  // doesn't throw on 4xx/5xx — silent failure otherwise.
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/alert-founder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        alert_type: alertType,
        context,
        dedup_key: dedupKey,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[heartbeat] alertFounder non-2xx: status=${res.status} type=${alertType} body=${body.substring(0, 300)}`,
      );
      return { ok: false, status: res.status, body: body.substring(0, 300) };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    console.error(
      `[heartbeat] alertFounder threw for type=${alertType}:`,
      e instanceof Error ? e.message : e,
    );
    return { ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}

async function pingHealthchecks(): Promise<boolean> {
  if (!HEALTHCHECKS_PING_URL) {
    console.warn("[heartbeat] HEALTHCHECKS_PING_URL not set; skipping ping");
    return false;
  }
  try {
    const res = await fetch(HEALTHCHECKS_PING_URL, { method: "GET" });
    if (!res.ok) {
      console.error(`[heartbeat] healthchecks.io ping non-2xx: status=${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      "[heartbeat] healthchecks.io ping threw:",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

// Stable dedup key for the stuck-rows alert. Uses a Web Crypto SHA-256 of
// the sorted row IDs so the same set of stuck rows dedups within the
// ALERT_CONFIG cooldown, and any change to the set (new row added, old row
// resolved) produces a different key and fires a fresh alert.
async function stuckRowsDedupKey(rowIds: string[]): Promise<string> {
  const sorted = [...rowIds].sort();
  const encoded = new TextEncoder().encode(sorted.join(","));
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `stuck_rows:${hashHex.substring(0, 16)}`;
}

// ── Handler ───────────────────────────────────────────────────────────────

serve(async (_req) => {
  const ranAt = new Date();
  const notes: string[] = [];
  let stuckRows: Array<Record<string, unknown>> = [];
  let cronFailures: Array<Record<string, unknown>> = [];
  let pingOk = false;
  let stuckAlertResult: { ok: boolean; status?: number; body?: string } | null = null;
  let cronAlertResult: { ok: boolean; status?: number; body?: string } | null = null;

  try {
    // ── Signal 1: stuck rows ──────────────────────────────────────────────
    const stuckThresholdIso = new Date(
      Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
    ).toISOString();

    const { data: stuck, error: stuckErr } = await supabase
      .from("pending_bookings")
      .select("id, merchant_ref, status, updated_at")
      .in("status", MONEY_TAKEN_NON_TERMINAL_STATUSES)
      .lt("updated_at", stuckThresholdIso)
      .order("updated_at", { ascending: true })
      .limit(50); // cap to protect against runaway payloads

    if (stuckErr) {
      throw new Error(`Signal 1 query failed: ${stuckErr.message}`);
    }
    stuckRows = stuck || [];

    if (stuckRows.length > 0) {
      const dedupKey = await stuckRowsDedupKey(
        stuckRows.map((r) => String(r.id)),
      );
      stuckAlertResult = await fireAlert(
        "HEARTBEAT_STUCK_ROWS",
        {
          count: stuckRows.length,
          threshold_minutes: STUCK_THRESHOLD_MINUTES,
          statuses_monitored: MONEY_TAKEN_NON_TERMINAL_STATUSES,
          rows: stuckRows,
        },
        dedupKey,
      );
      if (!stuckAlertResult.ok) {
        notes.push(
          `Signal 1 alert dispatch failed: status=${stuckAlertResult.status ?? "n/a"}`,
        );
      }
    }

    // ── Signal 2: cron auth health ────────────────────────────────────────
    const { data: failures, error: cronErr } = await supabase.rpc(
      "get_recent_http_failures",
      { window_minutes: CRON_FAILURE_WINDOW_MINUTES },
    );

    if (cronErr) {
      throw new Error(`Signal 2 query failed: ${cronErr.message}`);
    }
    cronFailures = failures || [];

    if (cronFailures.length > 0) {
      // Bucket by status_code so the alert makes it easy to see whether
      // this is a single bad code (probably auth) or mixed (probably
      // a broader outage).
      const bucketByCode: Record<string, number> = {};
      for (const f of cronFailures) {
        const code = String((f as { status_code?: number }).status_code ?? "null");
        bucketByCode[code] = (bucketByCode[code] || 0) + 1;
      }

      cronAlertResult = await fireAlert(
        "HEARTBEAT_CRON_FAILURES",
        {
          count: cronFailures.length,
          window_minutes: CRON_FAILURE_WINDOW_MINUTES,
          bucket_by_status_code: bucketByCode,
          sample_failures: cronFailures.slice(0, 10), // don't dump hundreds
        },
        "cron_failures",
      );
      if (!cronAlertResult.ok) {
        notes.push(
          `Signal 2 alert dispatch failed: status=${cronAlertResult.status ?? "n/a"}`,
        );
      }
    }

    // ── External liveness ping (healthchecks.io) ──────────────────────────
    // Fires ONLY after both signals completed their work (queries + any
    // alert dispatches). A successful ping means end-to-end healthy;
    // absence of ping means either the EF didn't run at all OR its work
    // errored — healthchecks.io alerts within the 65min grace either way.
    pingOk = await pingHealthchecks();
    if (!pingOk) {
      notes.push("healthchecks.io ping failed");
    }

    // ── Audit row ─────────────────────────────────────────────────────────
    const { error: auditErr } = await supabase.from("heartbeat_runs").insert({
      ran_at: ranAt.toISOString(),
      stuck_row_count: stuckRows.length,
      cron_failure_count: cronFailures.length,
      healthchecks_ping_ok: pingOk,
      stuck_rows_context:
        stuckRows.length > 0
          ? {
              rows: stuckRows,
              alert_dispatch: stuckAlertResult,
            }
          : null,
      cron_failures_context:
        cronFailures.length > 0
          ? {
              failures: cronFailures,
              alert_dispatch: cronAlertResult,
            }
          : null,
      notes: notes.length > 0 ? notes.join(" | ") : null,
    });
    if (auditErr) {
      console.error("[heartbeat] audit insert failed:", auditErr.message);
      // Don't throw — audit failure shouldn't fail the heartbeat.
      // The healthchecks.io ping already succeeded above; a missing audit
      // row is a lesser signal than a missing ping.
    }

    return new Response(
      JSON.stringify({
        ok: true,
        ran_at: ranAt.toISOString(),
        stuck_row_count: stuckRows.length,
        cron_failure_count: cronFailures.length,
        healthchecks_ping_ok: pingOk,
        notes,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    // Any unhandled error path: log, attempt an audit row insert so we can
    // reconstruct what happened later, but do NOT ping healthchecks.io.
    // Absence of ping is the signal.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[heartbeat] unhandled error:", msg);
    try {
      await supabase.from("heartbeat_runs").insert({
        ran_at: ranAt.toISOString(),
        stuck_row_count: stuckRows.length,
        cron_failure_count: cronFailures.length,
        healthchecks_ping_ok: false,
        notes: `Unhandled error: ${msg}`,
      });
    } catch (auditErr) {
      console.error(
        "[heartbeat] failsafe audit insert also failed:",
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
    }
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});