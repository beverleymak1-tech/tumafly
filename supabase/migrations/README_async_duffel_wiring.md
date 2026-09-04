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

### History

- **2026-07-19** — initial rotation. Value accidentally pasted in a chat
  log during Session 28b, discovered same day. Rotated cleanly via the
  procedure now documented in SOP §1.5.

- **Undated (between 2026-07-20 and 2026-08-13)** — a second rotation
  was performed via `supabase secrets set PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET`
  which updated the Edge Function env var. **The DB webhook trigger's
  hardcoded `x-webhook-secret` header value was NOT updated.** This
  silently broke every real customer booking from that point forward
  (approximately 2026-08-14 based on the last successful booking
  timestamp). Twelve days of silent breakage. No alert fired because
  the failure mode is "safeCompare returns false → HTTP 401 → no alert
  code path reached." Discovered during Session 38 (2026-08-26) when
  Bev noticed test bookings landing at State 2 "we're finalizing" and
  never resolving.

- **2026-08-26** — third rotation, executed correctly this time.
  Followed the full procedure now documented in SOP §1.5:
    1. New secret generated via `openssl rand -hex 32`
    2. Stashed in shell via `read -s` to avoid history exposure
    3. `supabase secrets set PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET`
    4. **Updated DB webhook trigger header value in Supabase Dashboard →
       Integrations → Webhooks → process-duffel-booking-webhook → HTTP
       Headers → x-webhook-secret**
    5. Redeployed 4 affected EFs: `process-duffel-booking`,
       `paystack-webhook`, `mpesa-callback`, `retry-stuck-bookings`
    6. Waited 90s for cold-start settling
    7. End-to-end smoke test: fresh KES-10 booking → PNR `2JMB6T`
       confirmed within seconds → State 1 rendered → full happy path
       restored end-to-end.

### Going forward

**Any rotation of this secret MUST follow the full procedure in
`TumaFly_SOP_Master.md` §1.5.** The critical step that has historically
been missed is step 4 (updating the DB webhook trigger's hardcoded
header value in the Supabase Dashboard). `supabase secrets set` alone
updates EF env vars but NOT the trigger header, causing silent
authentication failure on every subsequent booking.

Rotation should also be paired with an end-to-end smoke test (real
KES-10 booking through the frontend) BEFORE marking the rotation
complete. This is now a universal SOP §1.5 requirement.

**Next rotation:** annually from 2026-08-26, or immediately on any
suspected secret exposure. Long-term structural fix: migrate the
trigger to read the secret from `vault.decrypted_secrets` at runtime
(like the `retry-stuck-bookings` cron does with `service_role_key`)
so future rotations propagate automatically. Scoped for post-Ops-1.

## Recovery

If the webhook is deleted or misconfigured:
1. `pending_bookings` rows will accumulate at `duffel_pending` state.
2. `retry-stuck-bookings` (#9 scope) sweeps them after 2min.
3. Customer impact: payment captured, no ticket, refund triggered
   automatically via `refundBooking()` after 5min force-fail window.

## Related documentation

- `TumaFly_SOP_Master.md` §1.5 — canonical rotation procedure for
  `PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET`. Includes the DB webhook
  trigger update step and the mandatory end-to-end smoke test.
- `TumaFly_SOP_Master.md` §1.2 — inventory subcategory for
  "Dashboard-embedded secrets" describing this coupling and the
  silent-failure risk.
- `TumaFly_RUNBOOK_Master.md` — diagnostic entry for "customer reports
  payment succeeded but no confirmation" points at the log check for
  `Missing/invalid x-webhook-secret` errors as the first thing to
  check when this class of failure is suspected.

## Session 38 incident postmortem

The 2026-08-14 → 2026-08-26 silent breakage was discovered only because
Bev happened to be doing test bookings for an unrelated task (Session 38
wa.me link work) and noticed State 2 rendering on every attempt.

**What went wrong:**
- Rotation of `PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET` propagated to
  one of two surfaces (EF env vars via `supabase secrets set`) but
  not the other (DB webhook trigger's hardcoded header value)
- Failure mode was silent: 401 responses from process-duffel-booking
  didn't fire any alert
- Pre-launch state meant no real customer traffic was flowing, so
  the breakage accumulated without external signal
- Post-deploy smoke test (`scripts/post_deploy_smoke.sh`) covers offer
  search but not the booking write path, so it kept passing

**What surfaced the incident:**
- Test booking attempt as part of unrelated task
- Diagnostic chain: `pending_bookings.status` stuck at `duffel_pending`
  → `retry-stuck-bookings` cron reporting success but EF logs showing
  only boot/shutdown → manual curl of `retry-stuck-bookings` works
  → `retry-stuck-bookings` returns `duffel_pending_orphan_alert_only`
  outcomes (false positive due to separate Duffel API filter bug) →
  Duffel dashboard shows no orders → `process-duffel-booking` logs
  show only `Missing/invalid x-webhook-secret` errors → DB trigger
  header value dumped via `information_schema.triggers` → header
  value doesn't match current Supabase secret → root cause identified

**Total diagnostic time:** ~90 minutes. Should be under 15 minutes
with proper runbook coverage (RUNBOOK DocUpdate Session 38 adds the
diagnostic entry).

**Longer-term prevention:**
- SOP §1.5 procedure now explicitly requires updating the DB webhook
  trigger header on every rotation
- SOP §1.5 now universally requires end-to-end smoke test at rotation
  time
- `post_deploy_smoke.sh` extension scoped for post-Ops-1 (to catch this
  class of failure within 24h of any future rotation)
- Long-term: migrate trigger to Vault-backed dynamic secret read
