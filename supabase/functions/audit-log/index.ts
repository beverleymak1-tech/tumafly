// supabase/functions/audit-log/index.ts
//
// Session 40 — Ops-1 audit_log receiver.
//
// Simple POST endpoint that validates and inserts one row into audit_log.
// Called fire-and-forget from other EFs at meaningful state transitions.
//
// Body shape (all fields required except payload):
//   {
//     actor_type:  'system' | 'ops' | 'customer',
//     actor_id:    string,             // see actor convention in migration file
//     action_type: string,             // e.g. 'payment_initialized'
//     target_type: 'pending_booking' | 'booking' | 'refund' | 'cancellation',
//     target_id:   string,             // UUID of the target row
//     payload?:    Record<string, unknown>  // defaults to {}
//   }
//
// Response:
//   200 { ok: true, id: <inserted uuid> }  on success
//   400 { ok: false, error: ... }          on validation failure
//   500 { ok: false, error: ... }          on insert failure
//
// Config: verify_jwt = false. Callers auth via service role Authorization
// header (same pattern as alert-founder). RLS on audit_log prevents anon
// abuse — service role is the only path that inserts.
//
// RUNBOOK cross-refs:
//   §1.6 — SERVICE_ROLE_KEY convention (NOT SUPABASE_SERVICE_ROLE_KEY)
//   §1.7 — response.ok discipline on callers of this EF

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const VALID_ACTOR_TYPES = new Set(["system", "ops", "customer"]);
const VALID_TARGET_TYPES = new Set([
  "pending_booking",
  "booking",
  "refund",
  "cancellation",
]);

// Module-scope client (S-34 cleanup pattern — same as alert-founder + heartbeat).
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface AuditLogBody {
  actor_type: string;
  actor_id?: string | null;
  action_type: string;
  target_type: string;
  target_id: string;
  payload?: Record<string, unknown>;
}

function validate(body: unknown): { ok: true; parsed: AuditLogBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.actor_type !== "string" || !VALID_ACTOR_TYPES.has(b.actor_type)) {
    return { ok: false, error: `actor_type must be one of: ${[...VALID_ACTOR_TYPES].join(", ")}` };
  }
  if (typeof b.action_type !== "string" || b.action_type.length === 0) {
    return { ok: false, error: "action_type is required and must be a non-empty string" };
  }
  if (typeof b.target_type !== "string" || !VALID_TARGET_TYPES.has(b.target_type)) {
    return { ok: false, error: `target_type must be one of: ${[...VALID_TARGET_TYPES].join(", ")}` };
  }
  if (typeof b.target_id !== "string" || b.target_id.length === 0) {
    return { ok: false, error: "target_id is required and must be a non-empty string" };
  }
  // actor_id: allowed to be null/omitted (rare — e.g. anon system events).
  // If present, must be string.
  if (b.actor_id != null && typeof b.actor_id !== "string") {
    return { ok: false, error: "actor_id, if present, must be a string" };
  }
  // payload: optional object.
  if (b.payload != null && (typeof b.payload !== "object" || Array.isArray(b.payload))) {
    return { ok: false, error: "payload, if present, must be an object" };
  }

  return {
    ok: true,
    parsed: {
      actor_type: b.actor_type,
      actor_id: (b.actor_id as string | null | undefined) ?? null,
      action_type: b.action_type,
      target_type: b.target_type,
      target_id: b.target_id,
      payload: (b.payload as Record<string, unknown> | undefined) ?? {},
    },
  };
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const v = validate(body);
  if (!v.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: v.error }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { data, error } = await supabase
    .from("audit_log")
    .insert({
      actor_type: v.parsed.actor_type,
      actor_id: v.parsed.actor_id,
      action_type: v.parsed.action_type,
      target_type: v.parsed.target_type,
      target_id: v.parsed.target_id,
      payload: v.parsed.payload,
    })
    .select("id")
    .single();

  if (error) {
    console.error(
      `[audit-log] insert failed: action=${v.parsed.action_type} target=${v.parsed.target_type}:${v.parsed.target_id} error=${error.message}`,
    );
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, id: data.id }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});