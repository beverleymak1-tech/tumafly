// supabase/functions/csp-report/index.ts
//
// Session 40 — CSP violation report receiver.
//
// Accepts violation reports POSTed by browsers on Content-Security-Policy-
// Report-Only violations. Dedups within a 5-min window per
// {directive, blocked_uri}, rate-limits per source IP, and logs each unique
// violation for Function-Log-based bake analysis.
//
// Bake protocol:
//   The frontend's _headers file sends CSP in Report-Only mode with
//   `report-uri` pointing at this EF. Browsers POST here on every violation.
//   7-day bake starts 2026-09-08 (Session 40 ship). On clean bake, F&R
//   Content-Security-Policy-Report-Only → Content-Security-Policy in
//   _headers to enforce.
//
// Config:
//   config.toml MUST have `verify_jwt = false` for this function —
//   browsers do NOT send Authorization on CSP reports.
//
// Deliberate design choices:
//   - No DB persistence for the bake window; Supabase Function Logs are the
//     data. If bake pattern justifies persistence at promote time, add a
//     csp_violations table then.
//   - In-memory dedup + rate limit is per-EF-instance (not global). Supabase
//     may run multiple instances under load; state is not shared. For a bake
//     tool this is fine — we're protecting log volume, not enforcing strict
//     quotas.
//   - Response is always 204. CSP reports are fire-and-forget; browsers
//     ignore any response body. Non-2xx triggers nothing useful.
//   - Content-Types handled: application/csp-report (legacy),
//     application/reports+json (Reporting API v1). Best-effort fallback for
//     missing/wrong Content-Type.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DEDUP_WINDOW_MS = 5 * 60 * 1000;       // 5 min
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 100;                  // per IP per hour
const MAX_SAMPLE_LEN = 200;                  // truncate script-sample + UA in logs

const dedupMap = new Map<string, number>();          // "directive:blocked_uri" → last-seen ms
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function cleanup(now: number): void {
  for (const [k, v] of dedupMap) {
    if (now - v > DEDUP_WINDOW_MS) dedupMap.delete(k);
  }
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders });
  }

  const now = Date.now();

  // Source IP for rate limiting (Supabase edge sets these)
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  // Rate limit — silently drop past 100/hour/IP (still 204 so browser doesn't log an error)
  const entry = rateLimitMap.get(ip);
  if (entry && now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT_MAX) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    entry.count += 1;
  } else {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
  }

  // Opportunistic cleanup ~1% of calls (cheap; keeps maps bounded)
  if (Math.random() < 0.01) cleanup(now);

  // Read body
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (!raw) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Parse per Content-Type, with best-effort fallback
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const violations: Record<string, unknown>[] = [];

  try {
    const parsed = JSON.parse(raw);

    if (contentType.includes("application/csp-report")) {
      // Legacy: { "csp-report": { ... } }
      if (parsed && typeof parsed === "object" && parsed["csp-report"]) {
        violations.push(parsed["csp-report"]);
      }
    } else if (contentType.includes("application/reports+json")) {
      // Reporting API: [{ "type": "csp-violation", "body": { ... } }, ...]
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (r?.type === "csp-violation" && r?.body) violations.push(r.body);
        }
      }
    } else {
      // Missing/unknown Content-Type — try both shapes
      if (parsed && typeof parsed === "object" && parsed["csp-report"]) {
        violations.push(parsed["csp-report"]);
      } else if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (r?.type === "csp-violation" && r?.body) violations.push(r.body);
        }
      } else if (parsed && typeof parsed === "object") {
        violations.push(parsed);
      }
    }
  } catch {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Dedup + log each unique violation
  for (const v of violations) {
    const directive =
      (v["violated-directive"] as string) ??
      (v["effectiveDirective"] as string) ??
      (v["violatedDirective"] as string) ??
      "unknown";
    const blockedUri =
      (v["blocked-uri"] as string) ??
      (v["blockedURL"] as string) ??
      (v["blockedUri"] as string) ??
      "unknown";

    const dedupKey = `${directive}:${blockedUri}`;
    const lastSeen = dedupMap.get(dedupKey);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
      continue; // duplicate within window — drop
    }
    dedupMap.set(dedupKey, now);

    const docUri =
      (v["document-uri"] as string) ?? (v["documentURL"] as string) ?? "unknown";
    const sourceFile =
      (v["source-file"] as string) ?? (v["sourceFile"] as string) ?? null;
    const lineNumber =
      (v["line-number"] as number) ?? (v["lineNumber"] as number) ?? null;
    const sample =
      (v["script-sample"] as string) ?? (v["sample"] as string) ?? null;
    const userAgent = req.headers.get("user-agent");

    console.log(
      "csp_violation",
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        source_ip: ip,
        document_uri: docUri,
        violated_directive: directive,
        blocked_uri: blockedUri,
        source_file: sourceFile,
        line_number: lineNumber,
        script_sample: typeof sample === "string" ? sample.slice(0, MAX_SAMPLE_LEN) : null,
        user_agent: userAgent ? userAgent.slice(0, MAX_SAMPLE_LEN) : null,
      }),
    );
  }

  return new Response(null, { status: 204, headers: corsHeaders });
});