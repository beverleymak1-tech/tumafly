import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ── Support contact ──────────────────────────────────────────────────────
// EDIT THESE before going live. Falsy values are silently omitted from the
// email so it never displays placeholders to customers.
const SUPPORT_WHATSAPP = "+254 700 000 000"; // TODO: real WhatsApp number
const SUPPORT_EMAIL    = "support@tumafly.com";
const SUPPORT_HOURS    = "Mon–Sun, 8am–8pm EAT";

// ── Formatting helpers ───────────────────────────────────────────────────
function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // "Tue, 30 Jun 2026" — UTC so we display the flight's stated local time
  return d.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    timeZone: "UTC",
  });
}
function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  });
}
// Duffel returns durations as ISO 8601 ("PT2H16M"). Render "2h 16m".
function formatDuration(iso: string | undefined | null): string {
  if (!iso) return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return iso;
  const h = parseInt(m[1] || "0");
  const min = parseInt(m[2] || "0");
  if (h === 0 && min === 0) return "";
  return [h > 0 ? `${h}h` : "", min > 0 ? `${min}m` : ""].filter(Boolean).join(" ");
}
function formatKes(n: number): string {
  return `KES ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "";
}
function titleFor(p: any): string {
  // Duffel `title` is 'mr' | 'mrs' | 'ms' | 'miss' | 'dr'
  return capitalize(p?.title || "");
}
function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Order helpers ────────────────────────────────────────────────────────
// Map service_id → service metadata across all segments + paid services.
// Used to look up seat designator and bag info.
function indexOrderServices(order: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const svc of (order?.services || [])) out[svc.id] = svc;
  return out;
}

// Build a map of segment_id → slice_index so we know which slice each
// seat belongs to (seats are stored per-segment in our contact JSON).
function segmentToSliceIndex(order: any): Record<string, number> {
  const out: Record<string, number> = {};
  (order?.slices || []).forEach((slice: any, i: number) => {
    for (const seg of (slice?.segments || [])) out[seg.id] = i;
  });
  return out;
}

// Each passenger inherits the same fare-included baggage per segment in a
// slice (per Duffel data model). Aggregate across baggages in the first
// segment's first passenger entry.
function includedBaggageForSlice(slice: any) {
  let checked = 0, carry = 0;
  const segPax = slice?.segments?.[0]?.passengers?.[0];
  for (const bag of (segPax?.baggages || [])) {
    if (bag.type === "checked") checked += Number(bag.quantity || 0);
    else if (bag.type === "carry_on") carry += Number(bag.quantity || 0);
  }
  return { checked, carry };
}

// Pull e-ticket numbers per passenger from order.documents
function ticketNumbersByPassenger(order: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const doc of (order?.documents || [])) {
    if (doc.type !== "electronic_ticket") continue;
    const pid = doc.passenger_id || doc.passenger_ids?.[0];
    if (!pid) continue;
    if (!out[pid]) out[pid] = [];
    out[pid].push(doc.unique_identifier);
  }
  return out;
}

// Render the change/cancel one-liner from order.conditions
function conditionsCopy(order: any): string {
  const c = order?.conditions;
  if (!c) return "Refer to your airline's fare rules for change and cancellation policy.";

  const lines: string[] = [];
  const chg = c.change_before_departure;
  const ref = c.refund_before_departure;

  if (chg) {
    if (!chg.allowed) {
      lines.push("Changes are not permitted on this fare.");
    } else if (chg.penalty_amount && Number(chg.penalty_amount) > 0) {
      lines.push(`Changes allowed for a fee of ${chg.penalty_currency} ${chg.penalty_amount} per passenger.`);
    } else {
      lines.push("Changes allowed at no additional fee.");
    }
  }
  if (ref) {
    if (!ref.allowed) {
      lines.push("This fare is non-refundable.");
    } else if (ref.penalty_amount && Number(ref.penalty_amount) > 0) {
      lines.push(`Cancellations refundable minus a ${ref.penalty_currency} ${ref.penalty_amount} fee per passenger.`);
    } else {
      lines.push("Cancellations fully refundable.");
    }
  }
  if (lines.length === 0) return "Refer to your airline's fare rules for change and cancellation policy.";
  return lines.join(" ");
}

// ── Email components ─────────────────────────────────────────────────────
// All inline styles. Tables for layout (email-safe). No external assets.

const BRAND_BLUE = "#3D95F5";
const TEXT_DARK  = "#0f1923";
const TEXT_MED   = "#4a5568";
const TEXT_LITE  = "#8a96a3";
const HAIR       = "#e2e8f0";
const BG_TINT    = "#f4f9ff";
const BG_PAGE    = "#f7f9fc";

function renderSliceCard(slice: any, label: string): string {
  if (!slice) return "";
  const firstSeg = slice.segments?.[0];
  const lastSeg = slice.segments?.[slice.segments.length - 1];
  if (!firstSeg || !lastSeg) return "";

  const dep = firstSeg.departing_at;
  const arr = lastSeg.arriving_at;
  const segCount = slice.segments.length;
  const sliceDuration = formatDuration(slice.duration);
  const inc = includedBaggageForSlice(slice);

  // Per-segment rows (flight number, aircraft, cabin)
  const segmentRows = slice.segments.map((seg: any, idx: number) => {
    const carrier = seg.marketing_carrier?.name || seg.operating_carrier?.name || "Airline";
    const carrierIata = seg.marketing_carrier?.iata_code || "";
    const flightNum = seg.marketing_carrier_flight_number ? `${carrierIata}${seg.marketing_carrier_flight_number}` : "";
    const aircraft = seg.aircraft?.name || null;
    const cabinPax = seg.passengers?.[0];
    // Use Duffel's standard cabin_class enum (e.g., "first") capitalized,
    // not cabin_class_marketing_name (airline marketing names like "Deluxe").
    // Itinerary view + My Trips both use cabin_class — email matches for consistency.
    const cabin = cabinPax?.cabin_class ? capitalize(cabinPax.cabin_class) : null;
    const segDur = formatDuration(seg.duration);
    const dep = `${formatTime(seg.departing_at)} · ${seg.origin?.iata_code || ""}${seg.origin?.terminal ? ` Term ${seg.origin.terminal}` : ""}`;
    const arrv = `${formatTime(seg.arriving_at)} · ${seg.destination?.iata_code || ""}${seg.destination?.terminal ? ` Term ${seg.destination.terminal}` : ""}`;

    const layoverNote = (idx < slice.segments.length - 1) ? (() => {
      const nextDep = new Date(slice.segments[idx + 1].departing_at).getTime();
      const thisArr = new Date(seg.arriving_at).getTime();
      const layoverMin = Math.round((nextDep - thisArr) / 60000);
      const layoverHrs = Math.floor(layoverMin / 60);
      const layoverMm = layoverMin % 60;
      const layoverTxt = layoverHrs > 0 ? `${layoverHrs}h ${layoverMm}m` : `${layoverMm}m`;
      return `
        <tr><td style="padding:8px 0 8px 0;">
          <div style="font-size:12px;color:${TEXT_LITE};border-top:1px dashed ${HAIR};padding-top:8px;">
            ↓ ${layoverTxt} layover at ${escapeHtml(seg.destination?.iata_code || "")}
          </div>
        </td></tr>`;
    })() : "";

    return `
      <tr><td style="padding:10px 0 ${idx < slice.segments.length - 1 ? '0' : '10'}px 0;">
        <!-- R4: airline + class are now two separate inline-block pills sized
             to content, rather than one 100%-width table. This stops the
             tinted background from stretching to the full card width — it
             now hugs the actual text content (similar to how city names
             above only span their text width). -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:14px;color:${TEXT_DARK};font-weight:600;">
              <span style="display:inline-block;background:#e8f3ff;border-radius:8px;padding:8px 12px;">
                ${escapeHtml(carrier)}${flightNum ? ` · ${escapeHtml(flightNum)}` : ""}
              </span>
            </td>
            <td align="right" style="font-size:13px;color:${BRAND_BLUE};font-weight:500;white-space:nowrap;">
              ${(() => {
                if (!cabin) return "";
                const fareCode = cabinPax?.fare_basis_code || "";
                const marker = fareCode ? ` (${escapeHtml(fareCode)})` : "";
                return `<span style="display:inline-block;background:#e8f3ff;border-radius:8px;padding:8px 12px;">Class: ${escapeHtml(carrier)} ${escapeHtml(cabin)}${marker}</span>`;
              })()}
            </td>
          </tr>
        </table>
        ${aircraft ? `<div style="font-size:12px;color:${TEXT_LITE};margin-top:6px;">Aircraft: ${escapeHtml(aircraft)}</div>` : ""}
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
          <tr>
            <td style="font-size:13px;color:${TEXT_MED};">${escapeHtml(dep)}</td>
            <td align="right" style="font-size:13px;color:${TEXT_MED};">${escapeHtml(arrv)}</td>
          </tr>
          ${segDur ? `<tr><td colspan="2" align="center" style="font-size:11px;color:${TEXT_LITE};padding-top:4px;">${escapeHtml(segDur)} flight</td></tr>` : ""}
        </table>
      </td></tr>
      ${layoverNote}
    `;
  }).join("");

  const baggageLine = (inc.checked + inc.carry > 0) ? `
    <tr><td style="padding:12px 0 0 0;border-top:1px solid ${HAIR};">
      <div style="font-size:12px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Included baggage</div>
      <div style="font-size:13px;color:${TEXT_MED};margin-top:4px;">
        ${inc.checked > 0 ? `${inc.checked} checked bag${inc.checked > 1 ? "s" : ""}` : ""}
        ${inc.checked > 0 && inc.carry > 0 ? " · " : ""}
        ${inc.carry > 0 ? `${inc.carry} carry-on bag${inc.carry > 1 ? "s" : ""}` : ""}
      </div>
    </td></tr>
  ` : "";

  return `
  <tr>
    <td style="background:#ffffff;padding:18px 24px;border-bottom:1px solid ${HAIR};">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</div>
            <div style="font-size:13px;color:${TEXT_MED};margin-top:2px;">${escapeHtml(formatDate(dep))}</div>
          </td>
          <td align="right" style="font-size:12px;color:${TEXT_LITE};">${sliceDuration ? `Total: ${escapeHtml(sliceDuration)}` : ""}${segCount > 1 ? ` · ${segCount} segments` : ""}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:12px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-size:24px;font-weight:700;color:${TEXT_DARK};letter-spacing:-0.5px;">${escapeHtml(slice.origin?.iata_code || "")}</div>
                  <div style="font-size:13px;color:${TEXT_MED};">${escapeHtml(slice.origin?.city_name || slice.origin?.name || "")}</div>
                </td>
                <td align="center" width="40%" style="color:${TEXT_LITE};font-size:14px;">→</td>
                <td align="right">
                  <div style="font-size:24px;font-weight:700;color:${TEXT_DARK};letter-spacing:-0.5px;">${escapeHtml(slice.destination?.iata_code || "")}</div>
                  <div style="font-size:13px;color:${TEXT_MED};">${escapeHtml(slice.destination?.city_name || slice.destination?.name || "")}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${segmentRows}
        ${baggageLine}
      </table>
    </td>
  </tr>`;
}

function renderPassengerCard(
  passenger: any,
  passengerIndex: number,
  ticketNumbers: string[],
  storedSeats: any[],
  storedBaggages: any[],
  segToSlice: Record<string, number>,
  order: any,
): string {
  const fullName = `${titleFor(passenger)} ${passenger.given_name || ""} ${passenger.family_name || ""}`.trim();
  const tickets = ticketNumbers.length ? ticketNumbers.join(", ") : "Issued at check-in";

  // Seats for this passenger (their entries in storedSeats)
  const mySeats = storedSeats.filter(s => s.passenger_index === passengerIndex);
  const sliceLabels = ["Outbound", "Return"];
  const seatLines = mySeats.length === 0 ? null : mySeats
    .map(s => {
      const sliceIdx = segToSlice[s.segment_id];
      const sliceLabel = (typeof sliceIdx === "number" ? sliceLabels[sliceIdx] : "") || "Flight";
      return `${sliceLabel}: <strong style="color:${TEXT_DARK};">${escapeHtml(s.designator)}</strong>`;
    })
    .join(" · ");

  // Paid bags for this passenger
  const myBags = storedBaggages.filter(b => b.passenger_index === passengerIndex);
  const bagLines = myBags.length === 0 ? null : myBags
    .map(b => {
      const qty = b.quantity || 1;
      const type = (b.bag_type || "checked").replace("_", " ");
      const weight = b.weight_kg ? `${b.weight_kg}kg ` : "";
      return `${qty}× ${weight}${type}`;
    })
    .join(" · ");

  // Frequent flyer programs — passed through to Duffel at booking and
  // returned on order.passengers[].loyalty_programme_accounts. Each entry
  // is { airline_iata_code, account_number }. Render as e.g. "KQ #123456".
  const ffPrograms: any[] = passenger.loyalty_programme_accounts || [];
  const ffLines = ffPrograms.length === 0 ? null : ffPrograms
    .map((ff: any) => `${escapeHtml(ff.airline_iata_code || "—")} <span style="font-family:'Courier New',monospace;color:${TEXT_DARK};">#${escapeHtml(ff.account_number || "—")}</span>`)
    .join(" · ");

  return `
  <tr>
    <td style="background:#ffffff;padding:16px 24px;border-bottom:1px solid ${HAIR};">
      <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Passenger ${passengerIndex + 1}</div>
      <div style="font-size:16px;font-weight:600;color:${TEXT_DARK};margin-top:4px;">${escapeHtml(fullName)}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
        <tr>
          <td style="font-size:13px;color:${TEXT_MED};padding:3px 0;">
            <span style="color:${TEXT_LITE};">E-ticket:</span>
            <span style="font-family:'Courier New',monospace;color:${TEXT_DARK};">${escapeHtml(tickets)}</span>
          </td>
        </tr>
        ${seatLines ? `<tr><td style="font-size:13px;color:${TEXT_MED};padding:3px 0;"><span style="color:${TEXT_LITE};">Seats:</span> ${seatLines}</td></tr>` : ""}
        ${bagLines ? `<tr><td style="font-size:13px;color:${TEXT_MED};padding:3px 0;"><span style="color:${TEXT_LITE};">Paid baggage:</span> ${escapeHtml(bagLines)}</td></tr>` : ""}
        ${ffLines ? `<tr><td style="font-size:13px;color:${TEXT_MED};padding:3px 0;"><span style="color:${TEXT_LITE};">Frequent flyer:</span> ${ffLines}</td></tr>` : ""}
      </table>
    </td>
  </tr>`;
}

function renderBreakdown(b: any): string {
  if (!b) return "";
  const baggageQty = b.baggage_qty || 0;
  const line = (label: string, value: number, suffix = "") => `
    <tr>
      <td style="font-size:14px;color:${TEXT_MED};padding:6px 0;">${escapeHtml(label)}${suffix}</td>
      <td align="right" style="font-size:14px;color:${TEXT_DARK};padding:6px 0;">${formatKes(value)}</td>
    </tr>`;
  return `
  <tr>
    <td style="background:#ffffff;padding:18px 24px;border-bottom:1px solid ${HAIR};">
      <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Fare Summary</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${line("Flight", b.flight, ` <span style="color:${TEXT_LITE};font-size:12px;">(taxes included)</span>`)}
        ${b.seats > 0 ? line("Seat selection", b.seats) : ""}
        ${b.baggage > 0 ? line("Baggage", b.baggage, baggageQty > 0 ? ` <span style="color:${TEXT_LITE};font-size:12px;">×${baggageQty}</span>` : "") : ""}
        ${line("TumaFly service fee", b.service_fee)}
        ${line("Payment processing", b.processing_fee)}
        <tr><td colspan="2" style="border-top:1px solid ${HAIR};padding-top:10px;"></td></tr>
        <tr>
          <td style="font-size:15px;color:${TEXT_DARK};font-weight:700;padding-top:4px;">Total paid</td>
          <td align="right" style="font-size:18px;color:${BRAND_BLUE};font-weight:700;padding-top:4px;">${formatKes(b.total)}</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderHtml(payload: any): string {
  const { order, pending, breakdown_kes } = payload;
  const isRoundTrip = (order?.slices?.length || 0) > 1;

  const ticketsByPax = ticketNumbersByPassenger(order);
  const segToSlice = segmentToSliceIndex(order);
  const passengerCards = (order?.passengers || []).map((p: any, i: number) =>
    renderPassengerCard(p, i, ticketsByPax[p.id] || [], pending?.seats || [], pending?.baggages || [], segToSlice, order)
  ).join("");

  const slices = order?.slices || [];
  const sliceCards = slices.map((s: any, i: number) => {
    const label = isRoundTrip ? (i === 0 ? "Outbound" : "Return") : "Your Flight";
    return renderSliceCard(s, label);
  }).join("");

  const supportLines: string[] = [];
  if (SUPPORT_WHATSAPP) supportLines.push(`WhatsApp: <strong style="color:${TEXT_DARK};">${escapeHtml(SUPPORT_WHATSAPP)}</strong>`);
  if (SUPPORT_EMAIL)    supportLines.push(`Email: <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:${BRAND_BLUE};text-decoration:none;">${escapeHtml(SUPPORT_EMAIL)}</a>`);
  if (SUPPORT_HOURS)    supportLines.push(`<span style="color:${TEXT_LITE};">${escapeHtml(SUPPORT_HOURS)}</span>`);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TumaFly Booking Confirmed — ${escapeHtml(order?.booking_reference || "")}</title>
</head>
<body style="margin:0;padding:0;background:${BG_PAGE};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG_PAGE};padding:32px 12px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- HEADER -->
      <tr><td style="background:${BRAND_BLUE};border-radius:14px 14px 0 0;padding:24px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">✈ TumaFly</div>
        <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:4px;">Your booking is confirmed</div>
      </td></tr>

      <!-- PNR -->
      <tr><td style="background:#ffffff;padding:24px;text-align:center;border-bottom:1px solid ${HAIR};">
        <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Booking Reference</div>
        <div style="display:inline-block;background:#e8f3ff;color:${BRAND_BLUE};font-family:'Courier New',monospace;font-size:26px;font-weight:700;padding:10px 24px;border-radius:8px;letter-spacing:3px;">${escapeHtml(order?.booking_reference || "—")}</div>
        <div style="font-size:13px;color:${TEXT_LITE};margin-top:10px;">Present this reference at check-in</div>
      </td></tr>

      <!-- SLICES -->
      ${sliceCards}

      <!-- PASSENGERS -->
      ${passengerCards}

      <!-- FARE BREAKDOWN -->
      ${renderBreakdown(breakdown_kes)}

      <!-- BEFORE YOU TRAVEL -->
      <tr><td style="background:#ffffff;padding:18px 24px;border-bottom:1px solid ${HAIR};">
        <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Before You Travel</div>
        <table cellpadding="0" cellspacing="0">
          <tr><td style="font-size:13px;color:${TEXT_MED};padding:4px 0;">✓ &nbsp;Valid passport (6+ months from travel date)</td></tr>
          <tr><td style="font-size:13px;color:${TEXT_MED};padding:4px 0;">✓ &nbsp;Required visa or eTA for your destination</td></tr>
          <tr><td style="font-size:13px;color:${TEXT_MED};padding:4px 0;">✓ &nbsp;Online check-in opens 24–48 hours before departure</td></tr>
          <tr><td style="font-size:13px;color:${TEXT_MED};padding:4px 0;">✓ &nbsp;Arrive 2–3 hours early for international flights</td></tr>
        </table>
      </td></tr>

      <!-- CHANGES & CANCELLATIONS -->
      <tr><td style="background:#ffffff;padding:18px 24px;border-bottom:1px solid ${HAIR};">
        <div style="font-size:11px;color:${TEXT_LITE};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Changes &amp; Cancellations</div>
        <div style="font-size:13px;color:${TEXT_MED};line-height:1.5;">${escapeHtml(conditionsCopy(order))}</div>
        <div style="font-size:12px;color:${TEXT_LITE};margin-top:6px;">Contact TumaFly support to request a change or cancellation.</div>
      </td></tr>

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

// ── HTTP handler ─────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const payload = await req.json();
    const { to, order, pending, breakdown_kes } = payload;

    if (!to || !order?.booking_reference) {
      return new Response(JSON.stringify({ error: "Missing required fields (to, order.booking_reference)" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const html = renderHtml({ order, pending, breakdown_kes });

    const firstSlice = order.slices?.[0];
    const subject = `✈ Booking Confirmed — ${order.booking_reference}` +
      (firstSlice ? ` | ${firstSlice.origin?.iata_code || ""} → ${firstSlice.destination?.iata_code || ""}` : "");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TumaFly <bookings@tumafly.com>",
        to: [to],
        subject,
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
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});