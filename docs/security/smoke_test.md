# TumaFly Post-Deploy Smoke Test

**Domain:** production deploy verification (`scripts/post_deploy_smoke.sh`)
**Owner:** Backend engineer with deploy ownership (currently: Founder)
**KYC alignment:** closes gap 2.13 (post-deploy smoke tests: synthetic health-check booking passes end-to-end)
**Introduced:** Session 35b (2026-08-18)
**S-04 close companion:** this document + `scripts/post_deploy_smoke.sh`

---

## 1. Purpose + scope

Source-of-truth attestation for the post-deploy end-to-end pipeline verification. Referenced by KYC §2.13 and the Security Framework doc's deploy-safety controls section.

**Threat model addressed.** Silent regressions on production deploys. Every deploy has non-zero probability of breaking a critical path (auth key rotation missed, env var misconfigured, EF interface signature drift, redaction misfire, Duffel API version mismatch, Paystack sandbox mode drift, etc.). Without automated verification, regressions surface at real customer touchpoint, often days or weeks later. The Session 34 SERVICE_ROLE_KEY silent-alert-loss regression in `get-baggage-options` (undetected for weeks; caught only by Session 35b audit sweep) is the canonical example.

**In scope:**
- End-to-end synthetic booking from `pending_bookings` insert → `process-duffel-booking` invocation → Duffel `/air/orders` call → `bookings` row creation → `send-confirmation` email delivery
- CRITICAL alert-quiet assertion (no alerts fired during the run)
- Cleanup of all synthetic rows across `alerts`, `bookings`, `pending_bookings`, `refunds` — via EXIT trap so it runs even on test failure

**Out of scope:**
- Frontend deploy verification — Cloudflare Pages has its own build health signal
- Paystack payment flow verification — the smoke test bypasses payment (jumps `pending_bookings.status` straight to `duffel_pending`). Verifying the Paystack path requires either sandbox payment automation (Paystack test cards + JS + browser) or synthesizing HMAC-signed webhook events. Deferred to Ops-1 alongside similar hardening.
- Load testing — this is a single-request health check, not a stress test

---

## 2. Configuration inventory

### 2.1 Script location + invocation

**Path:** `scripts/post_deploy_smoke.sh`
**Runtime:** Bash 4+ with `curl` + `jq`
**Duration:** ~30-60 seconds per run

**Standard invocation** (from repo root, with env vars set):
```bash
export SB_URL="https://wmplcauhaqtyenwvkrkq.supabase.co"
export SERVICE_ROLE_KEY="<from Supabase Dashboard → Settings → API>"
export DUFFEL_READ_KEY="<sandbox read-only key from Duffel Dashboard, or DUFFEL_API_KEY as fallback>"
export PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET="<from Supabase secrets>"
./scripts/post_deploy_smoke.sh
```

**Optional overrides:**
```bash
export SMOKE_EMAIL="different@address.com"    # default: beverley.mak1+smoketest@gmail.com
export SMOKE_ROUTE="LHR-CDG"                  # default: LHR-JFK
export SMOKE_DATE="2027-03-15"                # default: 90 days out from today
```

### 2.2 Test flow (6 phases)

**Phase 1 — Reachability check.** Ping Duffel `/air/airlines` and Supabase `/rest/v1/pending_bookings`. Validates DUFFEL_API_KEY + SERVICE_ROLE_KEY + network + rate limits.

**Phase 2 — Fetch real Duffel sandbox offer.** Create an `/air/offer_requests` with `return_offers=true`. Extract first offer. Validates Duffel sandbox is live + returning offers for the chosen route/date.

**Phase 3 — Insert synthetic `pending_bookings` row.** Direct PostgREST insert with `status='duffel_pending'`, `merchant_ref='TF-SMOKETEST-<timestamp>'`. Skips payment flow entirely; the pre-payment stages (search, offer, price-drift, Paystack init) are covered by other production traffic + the tests in `scripts/verify_secrets.sh`.

**Phase 4 — Invoke `process-duffel-booking`.** POST to the EF with `x-webhook-secret` auth + `{pending_booking_id}` payload. This kicks off the real Duffel `/air/orders` call.

**Phase 5 — Poll for booking confirmation.** Query `bookings` table every 2s for up to 60s, looking for `status='confirmed'` + `pnr` populated.

**Phase 6 — Assertions:**
- Booking row exists with `status='confirmed'`
- `pnr` populated
- `confirmation_email_sent_at` populated
- Zero CRITICAL alerts fired for the smoke test's `merchant_ref`

### 2.3 Cleanup mechanism

**EXIT trap** ensures cleanup runs regardless of test outcome — pass, fail, script-crash, ctrl-C. Deletes all rows across `alerts` + `bookings` (via `pending_booking_id IN (…)` — bookings has no `merchant_ref` column) + `pending_bookings` + `refunds` where `merchant_ref LIKE 'TF-SMOKETEST-%'`.

**Belt-and-suspenders:** cleanup runs BOTH at script start (catches orphans from prior failed runs) AND at script exit. Missed cleanup from a network partition or SIGKILL would accrete synthetic rows until the next successful run's opening cleanup catches them.

**Duffel-side orders are NOT programmatically cancelled** — Duffel's `duffel_airways` test airline refuses `/air/order_cancellations` for ticketed sandbox orders (returns `cancellation_not_supported`). See §5 for the manual dashboard cleanup workflow. Synthetic passengers use `given_name: "Smoke"` + `family_name: "Test"` for easy identification in Duffel dashboard.

### 2.4 Expected pollution

Per successful run:
- 1 confirmation email delivered to `SMOKE_EMAIL` (default: filtered founder inbox via `+smoketest` extension)
- 0-1 Resend deliveries counted against free-tier quota (100/day)
- 1 synthetic Duffel sandbox order (ephemeral)

Per failed run: same as above plus 0-3 alert rows in the alerts table (deleted by cleanup).

---

## 3. Verification

### 3.1 Manual invocation post-deploy

Standard practice — after every `supabase functions deploy`, run:
```bash
./scripts/post_deploy_smoke.sh
```

Expected pass output ends with:
```
[smoke] ✅ PASS — end-to-end pipeline healthy
```

Non-zero exit code = investigate before pushing.

### 3.2 Test the test — sanity fixture

To verify the smoke test itself is wired correctly (not just skipping assertions), invoke with a deliberately broken env:
```bash
DUFFEL_API_KEY="invalid_key" ./scripts/post_deploy_smoke.sh
```
Expected: Phase 1 FAILS with "Duffel API unreachable or key invalid", cleanup runs, exit code 1.

### 3.3 Post-run manual spot check

```sql
-- Should be zero after any successful run + cleanup
SELECT COUNT(*) FROM pending_bookings WHERE merchant_ref LIKE 'TF-SMOKETEST-%';
SELECT COUNT(*) FROM bookings WHERE merchant_ref LIKE 'TF-SMOKETEST-%';
SELECT COUNT(*) FROM alerts WHERE context->>'merchant_ref' LIKE 'TF-SMOKETEST-%';
```

Non-zero counts = investigate (either cleanup failed, or a prior run's cleanup was interrupted).

---

## 4. Rollback

The script is standalone and non-destructive to production data (all writes namespaced under `TF-SMOKETEST-%` prefix). Rollback options:

- **Disable execution:** stop invoking it. No lingering effect on the system.
- **Remove the script:** `git rm scripts/post_deploy_smoke.sh` + `git rm docs/security/smoke_test.md`. Reverts the KYC drift item 2.13 to open.

No production data was ever touched by the test's synthetic path.

---

## 5. Backlog / known limitations

**Duffel-side sandbox cleanup is manual.** Duffel's `duffel_airways` test airline returns `cancellation_not_supported` from `/air/order_cancellations` for ticketed sandbox orders. The smoke test's cleanup does NOT attempt Duffel cancellation (it only cleans up our own DB rows). Sandbox orders persist in Duffel dashboard until either (a) manual cancellation via Duffel dashboard, or (b) Duffel's 60-day inactivity purge for the test account. Manual dashboard cleanup should happen periodically — easy to spot since synthetic passengers use `family_name: "Test"` and `given_name: "Smoke"`.

**Paystack payment path not covered.** Smoke test jumps `pending_bookings.status` from insert directly to `duffel_pending`, bypassing `pending` → `paid` → `paystack-webhook` → `verify-payment`. This trades payment-path coverage for zero risk of unintended Paystack sandbox charges + zero Paystack sandbox rate consumption per deploy. Full payment-path coverage requires either (a) Paystack sandbox headless-browser automation with test cards, or (b) HMAC-signed synthetic webhook events. Deferred to Ops-1.

**Duffel sandbox route + date dependence.** The default route `LHR-JFK` at +90 days is a route Duffel sandbox reliably returns offers for. If Duffel sandbox behavior changes (route retirement, date-window changes), Phase 2 will fail. Recovery: set `SMOKE_ROUTE` + `SMOKE_DATE` env vars to a working combination and update this doc's §2.1.

**Automated invocation deferred.** Currently runs on manual invocation post-deploy. Automating via GitHub Action or Supabase cron is deferred to Ops-1 — needs on-call rotation to receive failure signals. Until then, discipline is manual per RUNBOOK §Deploy Procedure.

**Real confirmation email delivery.** Each successful run sends a real confirmation email via Resend. Uses free-tier quota (100/day) — at current deploy cadence (~1-3/day), negligible. If cadence increases, add a `X-Smoke-Test: 1` header check in `send-confirmation` to skip delivery.

**Expected PROCESS_DUFFEL_PAYSTACK_VERIFY_MISMATCH alert noise.** Each smoke test run fires 1 HIGH-severity alert to `alerts@tumafly.com` — the synthetic paystack_tx_id can't be verified by Paystack (correctly triggers the soft-degrade branch). Recommend Gmail/mail filter: `subject:PROCESS_DUFFEL_PAYSTACK_VERIFY_MISMATCH AND body:"TF-SMOKETEST"` → auto-archive with `smoke-test-noise` label.

---

## 6. Change management

See SOP Master §6 — Configuration Change Management.

The script itself is versioned in git — any modification follows normal commit review. The environment variables the script requires (SB_URL, SERVICE_ROLE_KEY, DUFFEL_API_KEY, PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET) are managed per SOP §1 (Secret Rotation).

If the pipeline shape changes (e.g., `pending_bookings` schema evolves, `process-duffel-booking` auth scheme changes, Duffel API version bump), update:
1. `scripts/post_deploy_smoke.sh` (the affected phase)
2. This document's §2.2 test flow description
3. §7 deployment record with the migration date

---

## 7. Deployment record

**Session 35b (2026-08-18):** initial smoke test infrastructure. Bash script + attestation doc + RUNBOOK reference. Duffel sandbox route: LHR-JFK. Verified with a successful run against production (see Session 35b handoff §Phase 5 verification).

**Configured by:** Founder (Bev) via chat handoff
**Session:** 35b

---

*End of post-deploy smoke test attestation. First landed Session 35b (2026-08-18).*
