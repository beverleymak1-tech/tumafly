// S-17 synthetic health-check (Session 46 Phase 5c)
//
// Probes 5 target EFs with TF-SYNHC-* sentinels, validates response shape
// strictly, and fires SYNTHETIC_HEALTH_CHECK_FAILED alert for each failure.
//
// A3-ONLY (belt + suspenders):
//   1. Excluded from deploy-prod.yml (never ships to prod).
//   2. Runtime refuse-to-run if SUPABASE_URL isn't A3's project ref.
//
// Caller contract (service-role auth required):
//   POST /functions/v1/health-check-synthetic
//   Body: {"mode": "cron" | "manual"}  — defaults to "cron"
//
// Response (always HTTP 200 so HEARTBEAT_CRON_FAILURES doesn't double-fire):
//   {
//     "run_id": "<uuid>",
//     "probe_source": "cron" | "manual",
//     "started_at": "<ISO>",
//     "duration_ms": <n>,
//     "total_probes": 5,
//     "passed": <n>,
//     "failed": <n>,
//     "alerts_fired": <n>,
//     "probes": [{"ef","ok","http_status","duration_ms","reason?"}, ...]
//   }
//
// Alerts: for each failed probe, fires SYNTHETIC_HEALTH_CHECK_FAILED with
//   dedup_key=`ef:<probed_ef>` and template_vars={probed_ef:"<name>"}.
//
// See RUNBOOK §YY (S-17 architecture) and Session 46 handoff.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const PAYSTACK_API_KEY = Deno.env.get("PAYSTACK_API_KEY"); // Used to sign paystack-webhook probe body (HMAC-SHA512)

const A3_PROJECT_REF = "nljxqcrmmkodbzsrzdba";
const ALERT_FOUNDER_URL = `${SUPABASE_URL}/functions/v1/alert-founder`;
const PROBE_TIMEOUT_MS = 10_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

type ProbeMode = "cron" | "manual";

type ProbeResult = {
  ef: string;
  ok: boolean;
  http_status: number;
  duration_ms: number;
  reason?: string;
};

type ProbeSpec = {
  ef: string;
  shortCode: string;
  path: string;
  authHeader?: string;
  buildBody: (sentinel: string) => string;
};

// ── HMAC-SHA512 signing for paystack-webhook probe ───────────────────────
async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Fire SYNTHETIC_HEALTH_CHECK_FAILED alert for one failed probe ────────
async function fireAlert(probedEf: string, result: ProbeResult): Promise<boolean> {
  try {
    const res = await fetch(ALERT_FOUNDER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        alert_type: "SYNTHETIC_HEALTH_CHECK_FAILED",
        dedup_key: `ef:${probedEf}`,
        template_vars: { probed_ef: probedEf },
        context: {
          probed_ef: probedEf,
          http_status: result.http_status,
          reason: result.reason || "unknown",
          duration_ms: result.duration_ms,
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error(
      `[health-check-synthetic] alert-founder call failed for ${probedEf}:`,
      (err as Error).message,
    );
    return false;
  }
}

// ── Run a single probe + validate response strictly ──────────────────────
async function runProbe(spec: ProbeSpec, sentinel: string): Promise<ProbeResult> {
  const started = performance.now();
  const url = `${SUPABASE_URL}${spec.path}`;
  const body = spec.buildBody(sentinel);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (spec.authHeader) headers["Authorization"] = spec.authHeader;

  // paystack-webhook requires HMAC-SHA512 signature on the exact body bytes.
  if (spec.ef === "paystack-webhook") {
    if (!PAYSTACK_API_KEY) {
      const duration_ms = Math.round(performance.now() - started);
      return {
        ef: spec.ef,
        ok: false,
        http_status: 0,
        duration_ms,
        reason: "env PAYSTACK_API_KEY missing — paystack probe cannot sign",
      };
    }
    headers["x-paystack-signature"] = await hmacSha512Hex(PAYSTACK_API_KEY, body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const duration_ms = Math.round(performance.now() - started);
    const http_status = res.status;

    if (!res.ok) {
      return {
        ef: spec.ef,
        ok: false,
        http_status,
        duration_ms,
        reason: `non-2xx status ${http_status}`,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = await res.json();
    } catch (_) {
      return {
        ef: spec.ef,
        ok: false,
        http_status,
        duration_ms,
        reason: "response body not JSON",
      };
    }

    // Strict shape validation — the whole point of synthetic probing is to
    // catch "it looked OK but the sentinel path wasn't engaged".
    if (parsed.synthetic !== true) {
      return {
        ef: spec.ef,
        ok: false,
        http_status,
        duration_ms,
        reason: `response.synthetic !== true (got ${JSON.stringify(parsed.synthetic)})`,
      };
    }
    if (parsed.ok !== true) {
      return {
        ef: spec.ef,
        ok: false,
        http_status,
        duration_ms,
        reason: `response.ok !== true (got ${JSON.stringify(parsed.ok)})`,
      };
    }
    if (parsed.ef !== spec.ef) {
      return {
        ef: spec.ef,
        ok: false,
        http_status,
        duration_ms,
        reason: `response.ef mismatch — expected "${spec.ef}", got ${JSON.stringify(parsed.ef)}`,
      };
    }

    return { ef: spec.ef, ok: true, http_status, duration_ms };
  } catch (err) {
    const duration_ms = Math.round(performance.now() - started);
    const errName = (err as Error).name;
    const reason = errName === "AbortError"
      ? `timeout after ${PROBE_TIMEOUT_MS}ms`
      : `fetch error: ${(err as Error).message}`;
    return { ef: spec.ef, ok: false, http_status: 0, duration_ms, reason };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Probe specs for the 5 target EFs ─────────────────────────────────────
function getProbeSpecs(): ProbeSpec[] {
  return [
    {
      ef: "verify-payment",
      shortCode: "vp",
      path: "/functions/v1/verify-payment",
      buildBody: (s) => JSON.stringify({ reference: s }),
    },
    {
      ef: "initialize-payment",
      shortCode: "ip",
      path: "/functions/v1/initialize-payment",
      buildBody: (s) => JSON.stringify({ passengers: [{ last_name: s }] }),
    },
    {
      ef: "paystack-webhook",
      shortCode: "pw",
      path: "/functions/v1/paystack-webhook",
      buildBody: (s) =>
        JSON.stringify({ event: "charge.success", data: { reference: s } }),
    },
    {
      ef: "send-confirmation",
      shortCode: "sc",
      path: "/functions/v1/send-confirmation",
      authHeader: `Bearer ${SERVICE_ROLE_KEY}`,
      buildBody: (s) => JSON.stringify({ order: { booking_reference: s } }),
    },
    {
      ef: "search-flights",
      shortCode: "sf",
      path: "/functions/v1/search-flights",
      buildBody: (s) => JSON.stringify({ _probe: s }),
    },
  ];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // ── Runtime refuse: A3-only ────────────────────────────────────────────
  // Belt-and-suspenders with deploy-prod.yml exclusion. If this EF somehow
  // lands on prod (manual deploy, workflow bug), refuse to run outright.
  if (!SUPABASE_URL.includes(A3_PROJECT_REF)) {
    return new Response(
      JSON.stringify({
        error: "health-check-synthetic is A3-only; refusing to run on non-A3 project",
      }),
      {
        status: 503,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  // ── Service-role auth ──────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const presented = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim();
  if (presented !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // ── Parse mode (defaults to "cron") ────────────────────────────────────
  let mode: ProbeMode = "cron";
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.mode === "manual") mode = "manual";
  } catch (_) {
    /* default */
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const run_id = crypto.randomUUID();
  const ts = Date.now();
  const specs = getProbeSpecs();

  // ── Run all probes in parallel ─────────────────────────────────────────
  const probeResults = await Promise.all(
    specs.map((spec) => {
      const sentinel = `TF-SYNHC-${mode}-${spec.shortCode}-${ts}`;
      return runProbe(spec, sentinel);
    }),
  );

  // ── Fire alerts for each failure (parallel) ────────────────────────────
  const failures = probeResults.filter((r) => !r.ok);
  const alertFiredResults = await Promise.all(
    failures.map((f) => fireAlert(f.ef, f)),
  );
  const alerts_fired = alertFiredResults.filter(Boolean).length;

  const duration_ms = Math.round(performance.now() - t0);
  const passed = probeResults.filter((r) => r.ok).length;
  const failed = probeResults.length - passed;

  console.log(
    `[health-check-synthetic] run=${run_id} mode=${mode} passed=${passed} failed=${failed} alerts_fired=${alerts_fired} duration_ms=${duration_ms}`,
  );

  return new Response(
    JSON.stringify({
      run_id,
      probe_source: mode,
      started_at: startedAt,
      duration_ms,
      total_probes: probeResults.length,
      passed,
      failed,
      alerts_fired,
      probes: probeResults,
    }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
  );
});