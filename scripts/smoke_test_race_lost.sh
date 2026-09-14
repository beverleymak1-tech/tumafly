#!/usr/bin/env bash
# scripts/smoke_test_race_lost.sh
# ============================================================================
# Session 40.b acceptance-criterion-C test. NOT the standard post-deploy
# smoke test (scripts/post_deploy_smoke.sh covers the single-invocation
# happy path). This script deliberately forces the double-invocation race
# that caused the Session 40.b incident, then asserts the fix holds:
#
#   - Exactly ONE bookings row is created
#   - Exactly ONE booking_created audit row fires
#   - NO duffel_order_failed audit fires
#   - NO refund_initiated audit fires
#   - pending_bookings.status ends at 'booked' or 'pnr_issued' (not
#     refund_pending / paid_offer_expired / paid_booking_failed)
#
# Reuses Phases 1-3 of post_deploy_smoke.sh (reachability, real Duffel
# sandbox offer, synthetic pending_bookings row) unchanged. Phase 4 is
# the only real difference: fires TWO concurrent invocations of
# process-duffel-booking against the SAME pending_booking_id instead of one,
# simulating the DB webhook's Retries:3 delivering a second invocation
# before the first completes (see TumaFly_Handoff_Session40b_DoubleFire.md
# §2 for the full incident writeup this test is guarding against).
#
# Required env vars: same as post_deploy_smoke.sh —
#   SB_URL, SERVICE_ROLE_KEY, DUFFEL_WRITE_KEY (or DUFFEL_API_KEY),
#   PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET
#
# Exit codes: 0 = race handled safely, 1 = race still causes damage,
# 2 = setup failure.
# ============================================================================

set -uo pipefail

SB_URL="${SB_URL:-}"
KEY="${SERVICE_ROLE_KEY:-}"
DUFFEL_KEY="${DUFFEL_WRITE_KEY:-${DUFFEL_API_KEY:-}}"
WEBHOOK_SECRET="${PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET:-}"

SMOKE_EMAIL="${SMOKE_EMAIL:-beverley.mak1+smoketest@gmail.com}"
SMOKE_PHONE="+254700000000"
SMOKE_ROUTE="${SMOKE_ROUTE:-LHR-JFK}"
SMOKE_DATE="${SMOKE_DATE:-$(date -d "+90 days" +%Y-%m-%d 2>/dev/null || date -v+90d +%Y-%m-%d)}"

TS=$(date +%s)
MERCHANT_REF="TF-SMOKETEST-RACE-$TS"
ORIGIN="${SMOKE_ROUTE%-*}"
DEST="${SMOKE_ROUTE#*-}"

for var in SB_URL KEY DUFFEL_KEY WEBHOOK_SECRET; do
  if [ -z "${!var}" ]; then
    echo "[race-smoke] SETUP FAIL: env var $var not set" >&2
    exit 2
  fi
done
command -v jq >/dev/null 2>&1 || { echo "[race-smoke] SETUP FAIL: jq not installed" >&2; exit 2; }

PENDING_ID=""

cleanup() {
  echo ""
  echo "[race-smoke] Cleanup: delete synthetic rows (local DB only; Duffel sandbox order not cancellable — see smoke_test.md §5)..."
  if [ -n "$PENDING_ID" ]; then
    curl -s -X DELETE "$SB_URL/rest/v1/audit_log?target_id=eq.$PENDING_ID" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: return=minimal" >/dev/null
    curl -s -X DELETE "$SB_URL/rest/v1/bookings?pending_booking_id=eq.$PENDING_ID" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: return=minimal" >/dev/null
    curl -s -X DELETE "$SB_URL/rest/v1/refunds?pending_booking_id=eq.$PENDING_ID" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: return=minimal" >/dev/null
    curl -s -X DELETE "$SB_URL/rest/v1/alerts?context->>pending_booking_id=eq.$PENDING_ID" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: return=minimal" >/dev/null
    curl -s -X DELETE "$SB_URL/rest/v1/pending_bookings?id=eq.$PENDING_ID" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: return=minimal" >/dev/null
  fi
  echo "[race-smoke] Cleanup done."
}
trap cleanup EXIT

# ── Phase 1: Reachability (abbreviated — full check is post_deploy_smoke.sh's job) ──
echo "[race-smoke] Phase 1: Reachability check..."
curl -sf -o /dev/null -H "Authorization: Bearer $DUFFEL_KEY" -H "Duffel-Version: v2" \
  "https://api.duffel.com/air/airlines?limit=1" || { echo "[race-smoke] FAIL: Duffel unreachable" >&2; exit 1; }
curl -sf -o /dev/null -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "$SB_URL/rest/v1/pending_bookings?limit=1&select=id" || { echo "[race-smoke] FAIL: Supabase unreachable" >&2; exit 1; }
echo "[race-smoke]   OK"

# ── Phase 2: Real Duffel sandbox offer ─────────────────────────────────────
echo "[race-smoke] Phase 2: Fetch Duffel sandbox offer ($SMOKE_ROUTE on $SMOKE_DATE)..."
OFFER_REQ_RES=$(curl -s -X POST "https://api.duffel.com/air/offer_requests?return_offers=true" \
  -H "Authorization: Bearer $DUFFEL_KEY" -H "Duffel-Version: v2" -H "Content-Type: application/json" \
  -d "{\"data\":{\"slices\":[{\"origin\":\"$ORIGIN\",\"destination\":\"$DEST\",\"departure_date\":\"$SMOKE_DATE\"}],\"passengers\":[{\"type\":\"adult\"}],\"cabin_class\":\"economy\"}}")
OFFER_ID=$(echo "$OFFER_REQ_RES" | jq -r '.data.offers[0].id // empty')
if [ -z "$OFFER_ID" ]; then
  echo "[race-smoke] FAIL: no offers for $SMOKE_ROUTE on $SMOKE_DATE" >&2
  echo "$OFFER_REQ_RES" | jq '.errors // .' >&2
  exit 1
fi
echo "[race-smoke]   Offer: $OFFER_ID"

# ── Phase 3: Insert synthetic pending_bookings row ────────────────────────
echo "[race-smoke] Phase 3: Insert synthetic pending_bookings row..."
INSERT_RES=$(curl -s -X POST "$SB_URL/rest/v1/pending_bookings" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"merchant_ref\": \"$MERCHANT_REF\",
    \"duffel_offer_id\": \"$OFFER_ID\",
    \"processor_transaction_id\": \"smoketest_synthetic_$TS\",
    \"passengers\": [{\"type\":\"adult\",\"title\":\"mr\",\"gender\":\"m\",\"given_name\":\"Smoke\",\"family_name\":\"Test\",\"born_on\":\"1990-01-01\",\"email\":\"$SMOKE_EMAIL\",\"phone_number\":\"$SMOKE_PHONE\"}],
    \"contact\": {\"email\":\"$SMOKE_EMAIL\",\"phone_number\":\"$SMOKE_PHONE\",\"seats\":[],\"baggages\":[]},
    \"base_amount_kes\": 100000,
    \"service_fee_kes\": 500,
    \"processing_fee_kes\": 500,
    \"total_kes\": 100000,
    \"payment_method\": \"card\",
    \"status\": \"duffel_pending\"
  }")
PENDING_ID=$(echo "$INSERT_RES" | jq -r '.[0].id // empty')
if [ -z "$PENDING_ID" ]; then
  echo "[race-smoke] FAIL: pending_bookings insert failed" >&2
  echo "$INSERT_RES" >&2
  exit 1
fi
echo "[race-smoke]   pending_booking_id: $PENDING_ID"

# ── Phase 4: FIRE TWO CONCURRENT INVOCATIONS — this is the test ───────────
# Both requests fired via background jobs with no delay between them,
# simulating the DB webhook's Retries:3 delivering a duplicate before the
# first invocation's Duffel POST has returned. Real Session 40.b incident
# showed a ~38ms gap between invocations; backgrounding two curls from bash
# produces a comparable or tighter gap.
echo "[race-smoke] Phase 4: Firing TWO concurrent process-duffel-booking invocations..."
curl -s -X POST "$SB_URL/functions/v1/process-duffel-booking" \
  -H "Content-Type: application/json" -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d "{\"record\":{\"id\":\"$PENDING_ID\"}}" -o /tmp/race_smoke_res_a.json &
PID_A=$!
curl -s -X POST "$SB_URL/functions/v1/process-duffel-booking" \
  -H "Content-Type: application/json" -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d "{\"record\":{\"id\":\"$PENDING_ID\"}}" -o /tmp/race_smoke_res_b.json &
PID_B=$!
wait $PID_A $PID_B
echo "[race-smoke]   Invocation A response: $(cat /tmp/race_smoke_res_a.json 2>/dev/null)"
echo "[race-smoke]   Invocation B response: $(cat /tmp/race_smoke_res_b.json 2>/dev/null)"

# ── Phase 5: Poll for terminal state ────────────────────────────────────────
echo "[race-smoke] Phase 5: Poll for terminal state (max 4 min)..."
FINAL_STATUS=""
for i in $(seq 1 60); do
  ROW=$(curl -s "$SB_URL/rest/v1/pending_bookings?id=eq.$PENDING_ID&select=status" \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY")
  FINAL_STATUS=$(echo "$ROW" | jq -r '.[0].status // empty')
  case "$FINAL_STATUS" in
    booked|pnr_issued|refund_pending|paid_offer_expired|paid_booking_failed)
      break ;;
  esac
  sleep 4
done
echo "[race-smoke]   Final pending_bookings.status: $FINAL_STATUS"

# ── Phase 6: Assertions per Session 40.b acceptance criterion C ───────────
echo "[race-smoke] Phase 6: Assertions..."
FAIL=0

BOOKINGS_COUNT=$(curl -s "$SB_URL/rest/v1/bookings?pending_booking_id=eq.$PENDING_ID&select=id" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq 'length')
echo "[race-smoke]   bookings rows for this pending_booking_id: $BOOKINGS_COUNT (expect 1)"
[ "$BOOKINGS_COUNT" -eq 1 ] || { echo "[race-smoke]   FAIL: expected exactly 1 bookings row" >&2; FAIL=1; }

BOOKING_CREATED_COUNT=$(curl -s "$SB_URL/rest/v1/audit_log?action_type=eq.booking_created&payload->>pending_booking_id=eq.$PENDING_ID&select=id" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq 'length')
echo "[race-smoke]   booking_created audit rows: $BOOKING_CREATED_COUNT (expect 1)"
[ "$BOOKING_CREATED_COUNT" -eq 1 ] || { echo "[race-smoke]   FAIL: expected exactly 1 booking_created audit row" >&2; FAIL=1; }

DUFFEL_FAILED_COUNT=$(curl -s "$SB_URL/rest/v1/audit_log?action_type=eq.duffel_order_failed&target_id=eq.$PENDING_ID&select=id" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq 'length')
echo "[race-smoke]   duffel_order_failed audit rows: $DUFFEL_FAILED_COUNT (expect 0)"
[ "$DUFFEL_FAILED_COUNT" -eq 0 ] || { echo "[race-smoke]   FAIL: expected 0 duffel_order_failed audit rows" >&2; FAIL=1; }

REFUND_COUNT=$(curl -s "$SB_URL/rest/v1/audit_log?action_type=eq.refund_initiated&payload->>pending_booking_id=eq.$PENDING_ID&select=id" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq 'length')
echo "[race-smoke]   refund_initiated audit rows: $REFUND_COUNT (expect 0)"
[ "$REFUND_COUNT" -eq 0 ] || { echo "[race-smoke]   FAIL: expected 0 refund_initiated audit rows" >&2; FAIL=1; }

case "$FINAL_STATUS" in
  booked|pnr_issued) echo "[race-smoke]   pending_bookings.status: OK ($FINAL_STATUS)" ;;
  *) echo "[race-smoke]   FAIL: pending_bookings.status is '$FINAL_STATUS', expected booked or pnr_issued" >&2; FAIL=1 ;;
esac

RACE_LOST_ALERT_COUNT=$(curl -s "$SB_URL/rest/v1/alerts?alert_type=eq.RACE_LOST_NO_BOOKING&context->>pending_booking_id=eq.$PENDING_ID&select=id" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq 'length')
if [ "$RACE_LOST_ALERT_COUNT" -gt 0 ]; then
  echo "[race-smoke]   NOTE: RACE_LOST_NO_BOOKING fired ($RACE_LOST_ALERT_COUNT) — the anomalous no-booking-found"
  echo "[race-smoke]         path triggered instead of the clean-bail path. Not necessarily a fix failure (see"
  echo "[race-smoke]         handler comment on timing gap), but worth checking Duffel dashboard for this order."
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "[race-smoke] ✅ PASS — race handled safely, real booking preserved, no false refund"
  exit 0
else
  echo "[race-smoke] ❌ FAIL — see errors above" >&2
  exit 1
fi
