# TumaFly Post-Deploy Smoke Test

**Domain:** production deploy verification (`scripts/post_deploy_smoke.sh`) + A3 sandbox on-demand verification (`--target a3` flag; Session 44)
**Owner:** Backend engineer with deploy ownership (currently: Founder)
**KYC alignment:** progresses gap 2.13 (post-deploy smoke tests — full payment-path coverage). Current disposition: 🟡 pending Session 52 cutover. See §8 for full status.
**Introduced:** Session 35b (2026-08-18)
**A3 sandbox target added:** Session 44 (2026-09-26 → 2026-09-29)
**S-04 close companion:** this document + `scripts/post_deploy_smoke.sh`

---

## 1. Purpose + scope

Source-of-truth attestation for the post-deploy end-to-end pipeline verification. Referenced by KYC §2.13 and the Security Framework doc's deploy-safety controls section.

**Threat model addressed.** Silent regressions on production deploys. Every deploy has non-zero probability of breaking a critical path (auth key rotation missed, env var misconfigured, EF interface signature drift, redaction misfire, Duffel API version mismatch, Paystack sandbox mode drift, etc.). Without automated verification, regressions surface at real customer touchpoint, often days or weeks later. The Session 34 SERVICE_ROLE_KEY silent-alert-loss regression in `get-baggage-options` (undetected for weeks; caught only by Session 35b audit sweep) is the canonical example.

**In scope (production target — automated script):**
- End-to-end synthetic booking from `pending_bookings` insert → `process-duffel-booking` invocation → Duffel `/air/orders` call → `bookings` row creation → `send-confirmation` email delivery
- CRITICAL alert-quiet assertion (no alerts fired during the run)
- Cleanup of all synthetic rows across `alerts`, `bookings`, `pending_bookings`, `refunds` — via EXIT trap so it runs even on test failure

**In scope (A3 sandbox target — §8, Session 44, on-demand only):**
- Full payment-path E2E including Paystack test-mode charge → paystack-webhook → verify-payment → paid → duffel_pending → booked → confirmation email
- **Pre-Session-52-cutover** (current state): requires manual HMAC-signed webhook simulation because Paystack test-mode webhook URL is currently pointing at production. Procedure documented at `docs/security/a3_e2e_webhook_simulation.md`.
- **Post-Session-52-cutover**: natural E2E once the Paystack test-mode webhook URL is flipped from production → A3 as part of the cutover playbook.

**Out of scope:**
- Frontend deploy verification — Cloudflare Workers has its own build health signal (per-version 8-char URL, see §8.1)
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
export DUFFEL_WRITE_KEY="<sandbox read+write key from Duffel Dashboard, or DUFFEL_API_KEY as fallback>"
export PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET="<from Supabase secrets>"
./scripts/post_deploy_smoke.sh
```

**A3 target invocation** (Session 44 §2.4, commit `36ce7e5`):
```bash
# Load A3 secrets first (never mix with prod env — see RUNBOOK §26.4a shell tab discipline)
export SERVICE_ROLE_KEY="<A3 SERVICE_ROLE_KEY>"
export DUFFEL_WRITE_KEY="<A3 DUFFEL_WRITE_KEY>"
export PROCESS_DUFFEL_BOOKING_WEBHOOK_SECRET="<A3 secret>"
./scripts/post_deploy_smoke.sh --target a3
# SB_URL defaults to https://nljxqcrmmkodbzsrzdba.supabase.co when --target a3 passed
```

Note: uses WRITE key because Phase 2 posts `POST /air/offer_requests` (Duffel classifies resource creation as a write operation, even for search requests).

**Flag options** (Session 44):
- `--target a3` — default `SB_URL` to A3 sandbox. Env `SB_URL` still overrides if set.
- `--target prod` — default `SB_URL` to production. Env `SB_URL` still overrides if set.
- `--target` omitted — use `SB_URL` from env; error if unset (original behavior, backward-compatible).
- `-h` / `--help` — usage output.

**Optional overrides:**
```bash
export SMOKE_EMAIL="different@address.com"    # default: beverley.mak1+smoketest@gmail.com
export SMOKE_ROUTE="LHR-CDG"                  # default: LHR-JFK
export SMOKE_DATE="2027-03-15"                # default: 90 days out from today
```

### 2.2 Test flow (6 phases)

**Phase 1 — Reachability check.** Ping Duffel `/air/airlines` and Supabase `/rest/v1/pending_bookings`. Validates DUFFEL_WRITE_KEY + SERVICE_ROLE_KEY + network + rate limits. Session 44 enrichment: on Supabase REST 401 with `--target` passed, error message names the target-mismatch pattern (JWT-project-scoping mismatch — production key hitting A3, or vice versa, 401s here). Recovery per RUNBOOK §26.x.

**Phase 2 — Fetch real Duffel sandbox offer.** Create an `/air/offer_requests` with `return_offers=true`. Extract first offer. Validates Duffel sandbox is live + returning offers for the chosen route/date.

**Phase 3 — Insert synthetic `pending_bookings` row.** Direct PostgREST insert with `status='duffel_pending'`, `merchant_ref='TF-SMOKETEST-<timestamp>'`. Skips payment flow entirely; the pre-payment stages (search, offer, price-drift, Paystack init) are covered by other production traffic + the tests in `scripts/verify_secrets.sh` + the A3 full-payment-path procedure in §8.

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

**Paystack payment path not covered by the automated script.** Smoke test jumps `pending_bookings.status` from insert directly to `duffel_pending`, bypassing `pending` → `paid` → `paystack-webhook` → `verify-payment`. This trades payment-path coverage for zero risk of unintended Paystack sandbox charges + zero Paystack sandbox rate consumption per deploy. **On-demand full payment-path coverage IS available via the A3 sandbox procedure documented in §8** (added Session 44). The automated script's payment-bypass shape is retained because A3 procedure is heavier-weight (manual browser interaction + real test-mode transactions + pre-cutover manual HMAC webhook simulation step).

**Duffel sandbox route + date dependence.** The default route `LHR-JFK` at +90 days is a route Duffel sandbox reliably returns offers for. If Duffel sandbox behavior changes (route retirement, date-window changes), Phase 2 will fail. Recovery: set `SMOKE_ROUTE` + `SMOKE_DATE` env vars to a working combination and update this doc's §2.1.

**Automated invocation deferred.** Currently runs on manual invocation post-deploy. Automating via GitHub Action is deferred to Session 45 (was Session 55 pre-Session-44.c reordering) — the branch-based CI wiring for `staging → A3` and `main → prod` auto-deploys is the natural home for automated smoke invocation. Until then, discipline is manual per RUNBOOK §Deploy Procedure.

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

**Session 35b (2026-08-18):** initial smoke test infrastructure. Bash script + attestation doc + RUNBOOK reference. Duffel sandbox route: LHR-JFK. Verified with a successful run against production (see Session 35b handoff §Phase 5 verification). At this session KYC 2.13 was 🟡 — coverage was ~80% (payment path bypassed).

**Session 44 (2026-09-26 → 2026-09-29):** A3 sandbox target added via `--target a3` flag (commit `36ce7e5`). On-demand full payment-path E2E procedure documented at `docs/security/a3_e2e_webhook_simulation.md` (transitional tool — obsolete post-Session-52 cutover). Sub-session 44.c executed the first end-to-end verification (booking `TF-1790697658928-al7x1s`, PNR `7UUILF`, `duffel_order_id: ord_0000BAuEwOiLA4pH1XUrxY`, 4-row audit_log lifecycle, confirmation email delivered, ~3.4s pipeline latency).

**KYC 2.13 disposition at Session 44 close:** remains 🟡. See §8 for the truthful-pass condition and evidence trail.

**Configured by:** Founder (Bev) via chat handoff
**Sessions:** 35b (initial), 44 (A3 on-demand coverage tool)

---

## 8. A3 sandbox — on-demand payment-path verification (Session 44)

**Purpose:** provide an on-demand mechanism to exercise the Paystack payment path end-to-end (`initialize-payment` → Paystack test-mode charge → `paystack-webhook` → `verify-payment` → `paid` → `duffel_pending` → `booked` → `send-confirmation`) against the A3 sandbox Supabase project, without touching production and without consuming production Paystack test-mode rate.

**Not a routine post-deploy smoke** pre-Session-52 cutover. Daily testing runs against production in Paystack test mode (zero real-money risk). The A3 procedure is heavier-weight and used on demand for specific verification needs.

### 8.1 A3 preview URL

A3 frontend runs on the `a3-frontend` branch of the repo (Session 44.c, commits `3f18f1d` + `66a3c3f`; renamed to `staging` post-Session-45 automation). Deploy target is Cloudflare **Workers-with-assets** (not Cloudflare Pages — the repo-root `wrangler.jsonc` is authoritative; each git push creates a new Worker version with an 8-char version ID). Preview URLs are per-version: `https://<version-id>-tumafly.tumelowrites.workers.dev`.

**Divergence from `main` on the `a3-frontend` branch** (three files, all frontend-config; backend/`supabase/`/`scripts/`/`docs/` untouched):

| File | Line | From | To |
|---|---|---|---|
| `frontend/index.html` | 8603 | SUPABASE_URL prod | A3 |
| `frontend/index.html` | 8604 | SUPABASE_ANON_KEY prod | A3 |
| `frontend/index.html` | 20893 | TURNSTILE_SITEKEY (prod, hostname-locked to tumafly.com) | Cloudflare always-pass `1x00000000000000000000AA` |
| `frontend/_headers` | 7 | CSP `connect-src` + `report-uri` prod host | A3 host (both) |

Do NOT merge `a3-frontend` to `main`. Cross-branch code flow: `main → a3-frontend` (backend/shared code only), never reverse.

**Discipline** (from Session 44.c discoveries; codified in RUNBOOK §26.6 for pre-Session-45 window, §28 for A3 preview procedure):
- Any backend URL swap MUST also swap the corresponding CSP `connect-src` + `report-uri` entries in `_headers`. `grep -c` for the production host in `_headers` is the regression gate.
- Turnstile sitekey/secret must be paired. If A3's server is always-pass, the client must be always-pass too.
- No frontend build step exists — divergent config MUST be committed to the branch, not set as Cloudflare env vars.

### 8.2 A3 on-demand smoke — walkthrough

Pre-Session-52-cutover shape (current state — requires webhook simulation):

1. Sign in to the A3 preview URL (OTP path may not work pre-Session-51 SEND_OTP_HOOK_SECRET provisioning — use guest checkout as fallback if OTP fails silent).
2. Search a route (default: LHR-JFK, ~90 days out — matches Duffel sandbox reliable-offer window).
3. Select any offer.
4. Complete traveler details + contact form.
5. Payment page → Paystack modal opens → **select the "success" radio simulation** → complete. This does not consume real Paystack rate for the completed charge — it's Paystack's test-mode success simulation.
6. **Manual webhook simulation step** (§8.3) — required pre-cutover.
7. Watch the frontend for `#pending` → `#confirmed` transition (~3-5s after webhook fires).
8. Verify DB state in A3 SQL editor per `docs/security/a3_e2e_webhook_simulation.md §6`.
9. Verify confirmation email arrived at whichever address was used.

Post-Session-52-cutover shape: steps 1-5 + 7-9 only. Step 6 goes away because Paystack test-mode webhook URL flips to A3 at cutover (see §8.4).

### 8.3 Paystack webhook simulation (pre-cutover; transitional)

**Full procedure in `docs/security/a3_e2e_webhook_simulation.md`.** That document is the source-of-truth for the HMAC-SHA512 signing procedure, failure signatures, and the Session 52 cutover obsolescence conditions.

**Short-form summary:** Paystack test-mode has ONE webhook URL, currently pointing at production (Paystack Developer Relations confirmed 2026-09-30 that per-mode webhook URLs are supported and the Session 52 cutover flip is a supported operation). A test-mode charge on the A3 preview URL fires the webhook to production, leaving A3's `pending_bookings` row stuck at `status='pending'`. The simulation script bridges this by manually constructing an HMAC-signed `charge.success` webhook payload and posting it directly to A3's `paystack-webhook` EF.

**On-demand use only.** Not part of routine post-deploy verification.

### 8.4 Post-Session-52 cutover — natural E2E

At Session 52 cutover, per `docs/security/a3_e2e_webhook_simulation.md §9.2`, the Paystack Test Mode Webhook URL flips from production → A3. After that flip:

- Test-mode charges from the A3 preview URL naturally fire their webhooks to A3
- Full E2E works without the §8.3 simulation script
- `docs/security/a3_e2e_webhook_simulation.md` becomes obsolete for its primary purpose
- Daily test-mode testing shifts from prod to A3 preview URL

At that point, **KYC 2.13 flips 🟡 → 🟢 (truthful pass).** The KYC v1.4 rev in Session 46 legal batch to James notes this pending state; the follow-on legal batch (or Session 52 close ancillary) formalizes the flip.

### 8.5 KYC 2.13 truthful-pass condition

**Current disposition (Session 44 close):** 🟡

- ✅ Sandbox environment (A3) exists and is operational
- ✅ Mechanism proven — full payment-path E2E works via A3 preview URL + manual HMAC simulation (44.c evidence, §8.6)
- ✅ Documented procedure lives at `docs/security/a3_e2e_webhook_simulation.md`
- ❌ Natural (unassisted) post-deploy smoke coverage of the payment path — gated on Paystack webhook routing flip at Session 52 cutover

**Truthful-pass trigger:** Session 52 cutover step 5 completes (Paystack Test Mode Webhook URL flipped from production → A3 per the cutover playbook). At that point:
- A3 preview URL becomes the natural test environment for the full payment path
- No manual simulation required
- Any deploy of A3 EFs can be smoke-tested against a natural payment-path booking flow
- KYC 2.13 becomes fully truthful

**Documentation update at flip:** this doc's §8.5 gets updated to reflect the flip; `docs/security/a3_e2e_webhook_simulation.md` gets its obsolescence note activated (§9 already anticipates this); Security Audit Remediation §13 gets a Session 52 truthful-pass entry.

### 8.6 A3 smoke evidence log

**Session 44.c (2026-09-29, first verification via §8.3 simulation):**
- merchant_ref: `TF-1790697658928-al7x1s`
- pending_booking_id: `8a185387-39c0-430b-8ed6-fef6936511b9`
- booking.id: `38cbf711-e311-4e7c-8cb5-a9ee2703447d`
- PNR: `7UUILF`
- duffel_order_id: `ord_0000BAuEwOiLA4pH1XUrxY`
- Carrier: Duffel Airways ZZ2274 (test-mode synthetic)
- Total: 35,592 KES (Paystack amount 3,559,200 kobo — matched cleanly, no amount_mismatch)
- Passenger email: encrypted-at-rest ✓ (Session 14b encryption pipeline verified)
- Pipeline latency (webhook trigger → email delivered): ~3.4s
- audit_log rows (in order): payment_initialized, payment_captured, booking_created, confirmation_email_sent
- Confirmation email delivered ✓
- Duffel PDF issued ✓

Subsequent on-demand smoke runs (Session 45 onwards, pre-cutover) append entries here with same-shape evidence.

---

*End of post-deploy smoke test attestation. First landed Session 35b (2026-08-18). A3 sandbox on-demand coverage added Session 44 (2026-09-29). KYC 2.13 remains 🟡 through Session 44 close; truthful-pass trigger is Session 52 cutover (Paystack test-mode webhook URL flip). See §8.5 for full disposition.*
