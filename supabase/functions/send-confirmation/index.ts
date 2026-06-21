import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const {
      to,
      booking_reference,
      airline,
      origin,
      destination,
      departure,
      arrival,
      return_airline,
      return_departure,
      return_arrival,
      passengers,
      trip_type,
      total_kes,
    } = await req.json();

    const isRoundTrip = trip_type === "round";
    const paxList = passengers.map((p: any) =>
      `${p.title.charAt(0).toUpperCase() + p.title.slice(1)} ${p.given_name} ${p.family_name}`
    ).join("<br>");

    const returnSection = isRoundTrip ? `
      <tr>
        <td style="padding:16px 24px;border-bottom:1px solid #e2e8f0;">
          <div style="font-size:11px;color:#8a96a3;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Return Flight</div>
          <div style="font-size:22px;font-weight:700;color:#0f1923;letter-spacing:-0.5px;">${origin} → ${destination}</div>
          <div style="font-size:14px;color:#4a5568;margin-top:4px;">${return_airline} · ${return_departure} → ${return_arrival}</div>
        </td>
      </tr>` : "";

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TumaFly Booking Confirmation</title>
</head>
<body style="margin:0;padding:0;background:#f7f9fc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fc;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td style="background:#3D95F5;border-radius:16px 16px 0 0;padding:28px 24px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:10px;">
                <span style="font-size:28px;">✈</span>
                <span style="font-size:22px;font-weight:700;color:white;letter-spacing:-0.3px;">TumaFly</span>
              </div>
              <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:4px;">Your booking is confirmed</div>
            </td>
          </tr>

          <!-- REFERENCE BOX -->
          <tr>
            <td style="background:#ffffff;padding:28px 24px;text-align:center;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:13px;color:#8a96a3;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Booking Reference</div>
              <div style="display:inline-block;background:#e8f3ff;color:#3D95F5;font-family:'Courier New',monospace;font-size:28px;font-weight:700;padding:10px 28px;border-radius:10px;letter-spacing:3px;">${booking_reference}</div>
              <div style="font-size:13px;color:#8a96a3;margin-top:12px;">Present this reference at check-in</div>
            </td>
          </tr>

          <!-- OUTBOUND FLIGHT -->
          <tr>
            <td style="background:#ffffff;padding:16px 24px;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:11px;color:#8a96a3;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">${isRoundTrip ? 'Outbound Flight' : 'Flight'}</div>
              <div style="font-size:22px;font-weight:700;color:#0f1923;letter-spacing:-0.5px;">${origin} → ${destination}</div>
              <div style="font-size:14px;color:#4a5568;margin-top:4px;">${airline} · ${departure} → ${arrival}</div>
            </td>
          </tr>

          <!-- RETURN FLIGHT (if round trip) -->
          ${returnSection}

          <!-- PASSENGERS -->
          <tr>
            <td style="background:#ffffff;padding:16px 24px;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:11px;color:#8a96a3;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Passengers</div>
              <div style="font-size:14px;color:#0f1923;line-height:1.8;">${paxList}</div>
            </td>
          </tr>

          <!-- TOTAL -->
          <tr>
            <td style="background:#ffffff;padding:16px 24px;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:11px;color:#8a96a3;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Total Paid</div>
              <div style="font-size:22px;font-weight:700;color:#3D95F5;">KES ${total_kes}</div>
            </td>
          </tr>

          <!-- FOOTER NOTE -->
          <tr>
            <td style="background:#f4f9ff;border:1px solid #bfdbfe;border-radius:0 0 16px 16px;padding:20px 24px;text-align:center;">
              <div style="font-size:13px;color:#4a5568;line-height:1.6;">
                For any changes or cancellations, please contact your TumaFly agent.<br>
                <span style="color:#3D95F5;font-weight:600;">Safe travels! ✈</span>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TumaFly <bookings@tumafly.com>",
        to: [to],
        subject: `✈ Booking Confirmed — ${booking_reference} | ${origin} → ${destination}`,
        html,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return new Response(JSON.stringify({ error: data }), {
        status: res.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, email_id: data.id }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});