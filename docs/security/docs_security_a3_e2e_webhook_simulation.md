# A3 E2E Assist — Paystack Webhook Simulation

**Location (target on commit):** `docs/security/a3_e2e_webhook_simulation.md`
**Author:** Session 44.c (Claude, Opus 4.7) + Session 44 (main) framing
**Date:** 2026-09-29 (procedure landed) / 2026-09-30 (attestation authored + Paystack
per-mode webhook URL support confirmed)
**Status:** **Transitional tool.** Pre-Session-52-cutover only. Obsolete once Paystack
test-mode webhook URL flips from production to A3 as part of the Session 52 cutover
playbook.
**Use case:** on-demand verification of a specific A3 booking pipeline event (schema
migration, secret rotation drill, RUNBOOK §19 lockstep validation). Not run routinely
— pre-cutover daily testing happens against production in Paystack test mode.
**KYC alignment:** partial — KYC 2.13 gates on Session 52 cutover for full truthful
close. See `smoke_test.md §8` for the composite attestation and the traffic-light
disposition.

---

## §1 Purpose

Advance an A3 `pending_booking` row from `pending` → `booked` when the Paystack
modal has completed successfully but the real Paystack webhook was fired to
production instead of A3.

**Why the mismatch exists pre-cutover.** Paystack maintains separate webhook
URLs for Test Mode and Live Mode (confirmed via Paystack Developer Relations
2026-09-30, see §9). Currently the Test Mode Webhook URL points at production
because production is in Paystack test mode until the Session 52 cutover
activates live keys. Any Paystack test-mode transaction completed on ANY
frontend — production OR the A3 preview URL — fires its webhook to production.
On A3 preview URL charges, this means:

- Production's `paystack-webhook` receives the callback with an unknown
  `merchant_ref` and fires an `UNHANDLED_ERROR` alert (correct behavior;
  the reference doesn't match any production `pending_bookings` row).
- A3's `pending_bookings` row is left stuck at `status='pending'` because
  `verify-payment` defers to the webhook for state transitions
  (see `supabase/functions/verify-payment/index.ts` — the webhook is the
  single source of truth for state transitions).

**This script bridges that gap** by manually constructing an HMAC-SHA512-signed
`charge.success` webhook payload and posting it directly to A3's
`paystack-webhook` EF.

## §2 When to use

- After completing a Paystack test-mode payment on the A3 preview URL and
  wanting to see the full pipeline complete on A3 (state transitions,
  audit_log lifecycle, confirmation email).
- Schema migration verification against A3 before promoting the migration to
  production.
- Secret rotation drills touching `PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET`
  where SOP §1.5 Step 7 E2E verification is needed against A3 rather than
  production.
- Any other case where "I want to see A3 handle a full E2E booking" is the
  question.

**Not** for routine post-deploy verification. Daily testing runs against
production in Paystack test mode (zero real-money risk). A3 is the safe
sandbox for specific-purpose testing; the routine E2E signal comes from prod.

## §3 Prerequisites

- A `[A3]` tab (yellow prompt via `mark-a3`; see RUNBOOK §26.4a).
- `curl`, `jq`, `openssl` available (default on Debian / Chromebook penguin).
- Paystack test secret key (from Paystack dashboard → Settings → API Keys →
  Test Secret Key; identical to A3's `PAYSTACK_API_KEY` — one shared
  Paystack test account serves both production and A3 pre-cutover).
- The `merchant_ref` of the stuck A3 `pending_booking` (from A3 SQL).
- Run within ~15 min of the Paystack modal completing — Duffel offer TTL
  constraint (offers expire ~15-20 min after issue).

**Security note on the key.** Paystack's HMAC-SHA512 signing scheme uses the
secret key itself as the HMAC secret. So `PAYSTACK_API_KEY` serves BOTH as
the Paystack API bearer token AND as the webhook signing secret. Do not
attempt to split them. **Per Paystack Developer Relations (2026-09-30):**
test-mode webhooks are signed with the test secret key (`sk_test_...`);
live-mode webhooks are signed with the live secret key (`sk_live_...`).
The receiving EF must verify signatures using the secret key for the
corresponding environment. See §9 for the post-cutover implications.

## §4 Procedure

```bash
# 1. Get the stuck merchant_ref from A3 SQL editor:
#    SELECT id, merchant_ref, status, created_at
#    FROM pending_bookings
#    ORDER BY created_at DESC
#    LIMIT 3;
#    Copy the newest 'pending' row's merchant_ref.

# 2. Set it here
STUCK_REF="TF-1790XXXXXXXXX-XXXXXX"   # <-- paste the ref

# 3. Load Paystack test secret key (won't be echoed or stored in history)
read -s -p "PAYSTACK_API_KEY (sk_test_...): " PS_KEY && echo
echo "length=${#PS_KEY}, prefix=${PS_KEY:0:8}"
# Expect: length ~44, prefix sk_test_

# 4. Fetch the transaction from Paystack (verifies key + gets clean tx data)
TX_JSON=$(curl -sS "https://api.paystack.co/transaction/verify/$STUCK_REF" \
  -H "Authorization: Bearer $PS_KEY")
echo "$TX_JSON" | jq '.data | {reference, id, status, amount, channel}'

TX_ID=$(echo "$TX_JSON"    | jq -r '.data.id')
AMOUNT=$(echo "$TX_JSON"   | jq -r '.data.amount')
CHANNEL=$(echo "$TX_JSON"  | jq -r '.data.channel')
STATUS=$(echo "$TX_JSON"   | jq -r '.data.status')
[ "$STATUS" = "success" ] || { echo "ABORT: Paystack status is $STATUS"; }

# 5. Construct the Paystack charge.success webhook payload
jq -n \
  --arg ref "$STUCK_REF" \
  --argjson id "$TX_ID" \
  --argjson amount "$AMOUNT" \
  --arg channel "$CHANNEL" \
  '{
    event: "charge.success",
    data: {
      reference: $ref,
      id: $id,
      amount: $amount,
      channel: $channel,
      status: "success",
      authorization: { channel: $channel }
    }
  }' > /tmp/webhook_body.json

# 6. HMAC-SHA512 sign the body with PAYSTACK_API_KEY (lowercase hex, Paystack's scheme)
SIG=$(openssl dgst -sha512 -hmac "$PS_KEY" -hex /tmp/webhook_body.json | awk '{print $NF}')
echo "Body $(wc -c < /tmp/webhook_body.json) bytes, sig length ${#SIG}"
# Expect: sig length 128 (SHA-512 = 64 bytes = 128 hex chars)

# 7. POST the signed webhook to A3's paystack-webhook EF
curl -sS -X POST \
  "https://nljxqcrmmkodbzsrzdba.supabase.co/functions/v1/paystack-webhook" \
  -H "Content-Type: application/json" \
  -H "x-paystack-signature: $SIG" \
  --data-binary @/tmp/webhook_body.json \
  -w "\n---\nHTTP: %{http_code}\n"
# Expect: response "ok", HTTP 200

# 8. Cleanup
unset PS_KEY
shred -u /tmp/webhook_body.json 2>/dev/null || rm /tmp/webhook_body.json
```

## §5 Expected outcome

The POST returns `ok` (HTTP 200) within ~1 second, meaning:

- Signature verified
- Event routed as `charge.success`
- `pending_bookings` row lookup succeeded
- Belt-and-braces Paystack re-verify succeeded (webhook calls Paystack API
  again with A3's key)
- Amount matched pending.total_kes within 1 KES

Then A3's `paystack-webhook` cascades inline through paid → atomic claim to
duffel_pending → Duffel order.create → PNR issued → send-confirmation via
Resend. Total pipeline: ~3-4 seconds.

## §6 Verification SQL

Run in A3 SQL editor after ~15-30s:

```sql
-- 1. Confirm pending_bookings advanced to 'booked'
SELECT id, status, merchant_ref, processor_transaction_id, updated_at
FROM pending_bookings
WHERE merchant_ref = 'TF-...';   -- <-- your STUCK_REF
-- Expect: status='booked'

-- 2. Confirm bookings row was created with PNR
SELECT id, booking_reference, duffel_order_id, airline, flight_number
FROM bookings
WHERE pending_booking_id = (
  SELECT id FROM pending_bookings WHERE merchant_ref = 'TF-...'
);
-- Expect: one row with PNR + duffel_order_id

-- 3. Confirm the 4-row audit_log lifecycle landed
SELECT action_type, actor_id, created_at
FROM audit_log
WHERE target_id = (
  SELECT id::text FROM pending_bookings WHERE merchant_ref = 'TF-...'
)
ORDER BY created_at ASC;
-- Expect: 4 rows in order — payment_initialized, payment_captured,
-- booking_created, confirmation_email_sent
```

## §7 Cleanup notes

- Every successful simulation creates a real booking row + PNR on A3.
  Session 50 pre-launch data hygiene sweep cleans these up.
- Production `UNHANDLED_ERROR` alerts triggered by the original Paystack webhook
  (which went to prod, not A3) will still fire and retry over ~24h. Label as
  "A3 smoke residue" in your inbox filter.
- Duffel test-mode PNR is real (visible in Duffel's dashboard) but issued
  against a synthetic airline (Duffel Airways ZZ####). Doesn't affect real
  Duffel account state beyond test-mode usage.

## §8 Failure signatures

If the POST doesn't return `ok`:

| HTTP | Response body | Likely cause |
|---|---|---|
| 401 | `{"error":"Invalid signature"}` | HMAC-SHA512 mismatch — verify `PS_KEY` exactly matches the value A3's `PAYSTACK_API_KEY` is set to. |
| 200 | `ok` but row doesn't advance | `merchant_ref` typo (wrong ref → `paystack-webhook` fires UNHANDLED_ERROR alert on A3 too). Check `STUCK_REF`. |
| 200 | `ok`, row goes to `amount_mismatch` | Paystack's `amount` doesn't match `pending.total_kes` within 1 KES. Very unlikely with test-mode; investigate if seen. |
| 5xx | Various | A3 EF cold-start failure, or downstream (Duffel offer expired → `paid_offer_expired`, RUNBOOK §19 secret drift → `WEBHOOK_SECRET_MISMATCH` alert). Check A3 EF logs. |

## §9 Obsolescence — Session 52 cutover

**Paystack per-mode webhook URL support confirmed 2026-09-30** by Benneth
(Developer Relations, Paystack). Per Paystack's response:

> "Paystack maintains separate webhook URLs for Test Mode and Live Mode. You
> can configure the Test Mode webhook independently from the Live Mode webhook
> under the API Keys & Webhooks settings. Changes made in one environment do
> not affect the other."

Reference: https://support.paystack.com/en/articles/10609026

The Session 52 cutover flip is therefore a supported one-click operation, and
the post-cutover state is architecturally clean.

### §9.1 Post-cutover configuration (target state)

```
Sandbox (A3)                    Production
-------------------             -------------------
sk_test_... API key             sk_live_... API key
Test Mode webhook URL           Live Mode webhook URL
  → A3 paystack-webhook           → prod paystack-webhook
Test-mode charges from          Live-mode charges from
  any frontend → A3               tumafly.com → prod
```

Both environments verify inbound webhook HMAC-SHA512 signatures using their
own environment's secret key. A test-mode webhook signed with `sk_test_...`
verifies at A3 (which holds `sk_test_...`); a live-mode webhook signed with
`sk_live_...` verifies at production (which holds `sk_live_...`). Cross-mode
signatures fail verification, providing implicit self-defense against
misconfiguration.

### §9.2 Cutover order (Session 52 playbook additions)

The three changes must land close together to minimize the drift window. Order
matters — do NOT flip the Test Mode Webhook URL to A3 before production is
live, because production's pre-cutover daily-testing E2E currently depends on
receiving test-mode webhooks at prod.

Recommended cutover sequence (all within the same maintenance window):

1. **Verify A3 configuration is ready.** A3 EF secrets already include
   `PAYSTACK_API_KEY=sk_test_...` (pre-configured). A3's `paystack-webhook`
   is deployed and healthy (Session 44 confirmed via §10 evidence).
2. **Update production `PAYSTACK_API_KEY` from `sk_test_...` → `sk_live_...`.**
   Update `PAYSTACK_MODE=live`. Redeploy affected EFs. Verify prod's
   `paystack-webhook` boots without errors (per RUNBOOK §1.6 post-deploy
   smoke discipline).
3. **Update production frontend from `pk_test_...` → `pk_live_...`.** Deploy
   the frontend swap.
4. **Configure Paystack Live Mode Webhook URL** to point at
   `https://wmplcauhaqtyenwvkrkq.supabase.co/functions/v1/paystack-webhook`
   (may already be set by Paystack during live activation review; confirm
   in the dashboard).
5. **Flip Paystack Test Mode Webhook URL** from
   `https://wmplcauhaqtyenwvkrkq.supabase.co/functions/v1/paystack-webhook`
   to `https://nljxqcrmmkodbzsrzdba.supabase.co/functions/v1/paystack-webhook`.
6. **Verify live path:** Session 53 Day-32 real-carrier KES-10 smoke exercises
   live-mode E2E on prod (per Roadmap Part IV.7 Session 53 scope).
7. **Verify test-mode-to-A3 path:** on any post-cutover A3 smoke, complete a
   Paystack test-mode payment on the A3 preview URL and confirm the webhook
   arrives naturally at A3 (no §4 simulation needed). Booking should advance
   to `booked` end-to-end.

After the cutover sequence completes, **this document becomes obsolete for its
primary purpose.** Retain it as reference — the HMAC signing procedure may be
useful for similar patterns in other integrations (e.g., Daraja callback
re-routing if that integration has a similar single-URL constraint at go-live).

### §9.3 Verification of §9.2 assumption on daily test-flow

Pre-cutover, Bev's daily testing exercises the payment path in Paystack test
mode against production. That signal remains available until Step 5 of §9.2
executes. After Step 5, daily test-mode testing shifts to the A3 preview URL
(natural E2E; no simulation script). The `smoke_test.md §8` attestation is
updated in the same Session 52 cutover work to reflect the post-cutover E2E
narrative.

## §10 Session 44.c first-verification evidence

The procedure was validated end-to-end on 2026-09-29 by Session 44.c:

- merchant_ref: `TF-1790697658928-al7x1s`
- pending_booking_id: `8a185387-39c0-430b-8ed6-fef6936511b9`
- booking.id: `38cbf711-e311-4e7c-8cb5-a9ee2703447d`
- PNR: `7UUILF`
- duffel_order_id: `ord_0000BAuEwOiLA4pH1XUrxY`
- Carrier: Duffel Airways ZZ2274 (test-mode synthetic)
- Total: 35,592 KES (Paystack amount 3,559,200 kobo — matched cleanly, no
  amount_mismatch)
- Payment method: card
- Passenger email: encrypted-at-rest ✓ (Session 14b encryption pipeline verified)
- Pipeline latency (webhook trigger → email delivered): ~3.4s
- audit_log rows (in order): payment_initialized, payment_captured,
  booking_created, confirmation_email_sent
- Confirmation email delivered ✓
- Duffel PDF issued ✓

Subsequent runs (Session 45 onwards) append entries to `smoke_test.md §8.6`
rather than here.

---

*End of A3 E2E webhook simulation attestation. Transitional tool; obsolete
post-Session-52 cutover per §9.*
