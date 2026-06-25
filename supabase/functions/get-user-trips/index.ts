// supabase/functions/get-user-trips/index.ts
// Returns the authenticated user's bookings for the My Trips view.
// Auth: expects Authorization: Bearer <supabase_jwt> header.
// verify_jwt = false in config.toml (consistent with all other TumaFly EFs).
// We do our own auth.getUser() call to get the uid.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    // ── 1. Verify caller is authenticated ──────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Use a user-scoped client to resolve the JWT to a uid
    const userClient = createClient(SUPABASE_URL, token, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Fetch bookings for this user ────────────────────────────────────
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    const { data: bookings, error: dbError } = await adminClient
      .from("pending_bookings")
      .select(`
        id,
        merchant_reference,
        pnr,
        status,
        contact,
        created_at
      `)
      .eq("user_id", user.id)
      .in("status", ["booked", "paid", "pending"])   // exclude abandoned/expired
      .order("created_at", { ascending: false })
      .limit(50);

    if (dbError) {
      console.error("[get-user-trips] DB error:", dbError);
      return new Response(JSON.stringify({ error: "Failed to fetch trips" }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Shape for frontend ──────────────────────────────────────────────
    // contact column already contains offer snapshot, passengers, totals etc.
    // Frontend My Trips view can render directly from this shape.
    const trips = (bookings ?? []).map((b) => ({
      id:                 b.id,
      merchantReference:  b.merchant_reference,
      pnr:                b.pnr ?? null,
      status:             b.status,
      createdAt:          b.created_at,
      // Spread the contact JSON so frontend gets offer, passengers, totalKes etc.
      ...(b.contact ?? {}),
    }));

    return new Response(JSON.stringify({ trips }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[get-user-trips] Unexpected error:", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});