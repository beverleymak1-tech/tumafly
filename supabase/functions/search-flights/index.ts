import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DUFFEL_API_KEY = Deno.env.get("DUFFEL_API_KEY");
const DUFFEL_BASE_URL = "https://api.duffel.com";

const FALLBACK_RATES: Record<string, number> = {
  GBP: 170, USD: 130, EUR: 140, AED: 35, QAR: 36,
};

async function toKES(amount: number, fromCurrency: string): Promise<{kes: number, rateDate: string | null, isLive: boolean}> {
  try {
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${fromCurrency}`);
    const data = await res.json();
    const rate = data.rates?.KES;
    if (rate) return {
      kes: Math.round(amount * rate),
      rateDate: data.date || new Date().toISOString().split('T')[0],
      isLive: true,
    };
  } catch {}
  return {
    kes: Math.round(amount * (FALLBACK_RATES[fromCurrency] || 130)),
    rateDate: null,
    isLive: false,
  };
}

// Calculate layover duration between two ISO datetimes
function layoverMinutes(arrival: string, departure: string): number {
  const arr = new Date(arrival).getTime();
  const dep = new Date(departure).getTime();
  return Math.round((dep - arr) / 60000);
}

function formatLayover(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const { origin, destination, date, return_date, passengers = 1 } = await req.json();

    const slices: any[] = [{ origin, destination, departure_date: date }];
    if (return_date) {
      slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    const offerRequestBody = {
      data: {
        slices,
        passengers: Array(passengers).fill({ type: "adult" }),
        cabin_class: "economy",
      },
    };

    const offerRequestRes = await fetch(
      `${DUFFEL_BASE_URL}/air/offer_requests?return_offers=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Content-Type": "application/json",
          "Duffel-Version": "v2",
          Accept: "application/json",
        },
        body: JSON.stringify(offerRequestBody),
      }
    );

    const offerRequestData = await offerRequestRes.json();

    if (!offerRequestRes.ok) {
      return new Response(JSON.stringify({ error: offerRequestData }), {
        status: offerRequestRes.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const offers = await Promise.all(
      offerRequestData.data.offers.map(async (offer: any) => {
        const originalAmount = parseFloat(offer.total_amount);
        const kesResult = await toKES(originalAmount, offer.total_currency);
        const kesAmount = kesResult.kes;

        // Also compute USD for toggle
        let usdAmount = originalAmount;
        if (offer.total_currency !== 'USD') {
          try {
            const usdRes = await fetch(`https://api.exchangerate-api.com/v4/latest/${offer.total_currency}`);
            const usdData = await usdRes.json();
            if (usdData.rates?.USD) usdAmount = Math.round(originalAmount * usdData.rates.USD * 100) / 100;
          } catch {}
        }

        return {
          id: offer.id,
          price: kesAmount,
          price_usd: usdAmount,
          rate_date: kesResult.rateDate,
          rate_is_live: kesResult.isLive,
          price_original: originalAmount,
          currency: "KES",
          currency_original: offer.total_currency,
          airline: offer.owner.name,
          airline_logo: offer.owner.logo_symbol_url,
          slices: offer.slices.map((slice: any) => {
            const segments = slice.segments.map((seg: any, idx: number) => {
              const segObj: any = {
                flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
                airline: seg.marketing_carrier.name,
                aircraft: seg.aircraft?.name || null,
                origin: seg.origin.iata_code,
                origin_name: seg.origin.name,
                origin_city: seg.origin.city_name,
                origin_country: seg.origin.iata_country_code,
                destination: seg.destination.iata_code,
                destination_name: seg.destination.name,
                destination_city: seg.destination.city_name,
                destination_country: seg.destination.iata_country_code,
                departure: seg.departing_at,
                arrival: seg.arriving_at,
                duration: seg.duration,
                cabin_class: seg.passengers?.[0]?.cabin_class_marketing_name || 'Economy',
              };

              // Add layover info (time at destination airport before next segment)
              if (idx < slice.segments.length - 1) {
                const nextSeg = slice.segments[idx + 1];
                segObj.layover_minutes = layoverMinutes(seg.arriving_at, nextSeg.departing_at);
                segObj.layover_formatted = formatLayover(segObj.layover_minutes);
                segObj.layover_overnight = segObj.layover_minutes >= 360; // 6+ hours
              }

              return segObj;
            });

            return {
              origin: slice.origin.iata_code,
              origin_name: slice.origin.name,
              origin_country: slice.origin.iata_country_code,
              destination: slice.destination.iata_code,
              destination_name: slice.destination.name,
              destination_country: slice.destination.iata_country_code,
              departure: slice.segments[0].departing_at,
              arrival: slice.segments[slice.segments.length - 1].arriving_at,
              duration: slice.duration,
              stops: slice.segments.length - 1,
              segments,
            };
          }),
        };
      })
    );

    return new Response(
      JSON.stringify({ success: true, count: offers.length, offers }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});