// supabase/functions/otp-precheck/index.ts
// Per-IP throttle preflight for OTP requests (S-07 Option 2).
// Frontend calls this BEFORE sb.auth.signInWithOtp() / sb.auth.updateUser({phone}).
// Returns 200 (proceed) or 429 (throttled).
//
// Closes KYC 1.16 per-IP dimension.
// Per-phone dimension enforced downstream in the send-otp hook (S-07c).

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SERVICE_ROLE_KEY")!;

// S-07b.1 diagnostic: log env-var presence at boot (length only, never values)
console.log(`[otp-precheck] boot — SUPABASE_URL: ${SUPABASE_URL ? "set" : "MISSING"}, SUPABASE_SERVICE_ROLE_KEY length: ${SUPABASE_SERVICE_ROLE?.length ?? 0}`);

// Throttle rule: 10 IP-scoped requests per rolling 15 minutes
const IP_WINDOW_MINUTES = 15;
const IP_LIMIT          = 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function extractClientIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const xreal = req.headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

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
      console.error(`[otp-precheck] alertFounder non-2xx: status=${res.status} type=${alert_type} body=${body.substring(0, 300)}`);
    } else {
      console.log(`[otp-precheck] alertFounder OK: type=${alert_type} status=${res.status}`);
    }
  } catch (e) {
    console.error(`[otp-precheck] alertFounder threw for type=${alert_type}:`, e instanceof Error ? e.message : e);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const ip = extractClientIp(req);
    const windowStart = new Date(Date.now() - IP_WINDOW_MINUTES * 60 * 1000).toISOString();

    // Count IP hits in rolling window (HEAD + count=exact returns 0-body + Content-Range)
    const countUrl =
      `${SUPABASE_URL}/rest/v1/otp_attempts` +
      `?select=id` +
      `&scope=eq.ip` +
      `&scope_value=eq.${encodeURIComponent(ip)}` +
      `&requested_at=gte.${encodeURIComponent(windowStart)}`;

    const countRes = await fetch(countUrl, {
      method:  "HEAD",
      headers: {
        "apikey":        SUPABASE_SERVICE_ROLE,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "Prefer":        "count=exact",
      },
    });

    if (!countRes.ok) {
      console.error("[otp-precheck] count query failed:", countRes.status);
      // Fail-open on infra error; alert so we notice
      await alertFounderTyped("OTP_PRECHECK_INFRA_ERROR", {
        stage:  "count",
        status: countRes.status,
      });
      return json({ ok: true, throttled: false, fallback: "infra_error" }, 200);
    }

    const contentRange = countRes.headers.get("content-range") ?? "*/0";
    const total = parseInt(contentRange.split("/")[1] ?? "0", 10);

    if (total >= IP_LIMIT) {
          // Threshold hit — do NOT record another attempt (would extend the window)
          console.log(`[otp-precheck] throttle HIT: total=${total} limit=${IP_LIMIT} — firing alert`);
          const hashedIp = await sha256Hex(ip);
                await alertFounderTyped("OTP_THROTTLE_HIT", {
                  scope:              "ip",
                  scope_value_sha256: hashedIp,
                  window_minutes:     IP_WINDOW_MINUTES,
                  limit:              IP_LIMIT,
                  observed_count:     total,
                }, `ip:${hashedIp}`);
      return json(
        { ok: false, throttled: true, retry_after_minutes: IP_WINDOW_MINUTES },
        429,
      );
    }

    // Under limit — record this attempt, then pass
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/otp_attempts`, {
      method:  "POST",
      headers: {
        "apikey":        SUPABASE_SERVICE_ROLE,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({ scope: "ip", scope_value: ip }),
    });

    if (!insertRes.ok) {
      console.error("[otp-precheck] insert failed:", insertRes.status);
      await alertFounderTyped("OTP_PRECHECK_INFRA_ERROR", {
        stage:  "insert",
        status: insertRes.status,
      });
      return json({ ok: true, throttled: false, fallback: "infra_error" }, 200);
    }

    return json({ ok: true, throttled: false }, 200);

  } catch (e) {
    console.error("[otp-precheck] unexpected error:", e instanceof Error ? e.message : e);
    return json({ ok: true, throttled: false, fallback: "unexpected_error" }, 200);
  }
});