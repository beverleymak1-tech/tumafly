# Async Duffel decoupling — DB webhook wiring

**Wired:** 2026-07-19 during Session 28b-part-2 commit #7c.
**Webhook name:** `process-duffel-booking-webhook`
**Registered at:** Supabase Dashboard → Integrations → Webhooks

## Configuration

- **Table:** `public.pending_bookings`
- **Event:** UPDATE
- **Condition:** fires on every UPDATE; entry-point guard in the EF
  handles the status filter (bails when status != 'duffel_pending')
- **Target:** Edge Function `process-duffel-booking`
- **Method:** POST
- **Headers:**
  - `Content-Type: application/json`
  - `x-webhook-secret: <PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET env var value>`
- **Timeout:** 30000ms
- **Retries:** 3

## Verified end-to-end 2026-07-19

Wire-test row `cf3ace6e-1fbd-40a9-b170-aab83139c289`:
`paid → duffel_pending → paid_offer_expired` in 2.6s. All three
transitions logged to `booking_status_history`. `PAID_NO_OFFER`,
`PROCESS_DUFFEL_PAYSTACK_VERIFY_MISMATCH`, and `REFUND_API_FAILED`
alert emails received. Confirmed post-secret-rotation.

## Rotation cadence

Secret was rotated once on 2026-07-19 (initial value accidentally
pasted in a chat log; discovered same-day). Old secret returns 401,
new returns 200. Set next rotation: before end of Session 30 (ops
dashboard buildout), then annually.

## Recovery

If the webhook is deleted or misconfigured:
1. `pending_bookings` rows will accumulate at `duffel_pending` state.
2. `retry-stuck-bookings` (#9 scope) sweeps them after 2min.
3. Customer impact: payment captured, no ticket, refund triggered
   automatically via `refundBooking()` after 5min force-fail window.
