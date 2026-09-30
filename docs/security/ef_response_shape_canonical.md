# EF Response Shape — Canonical Design

**Location (target on commit):** `docs/security/ef_response_shape_canonical.md`
**Author:** Session 44.b (Claude, Opus 4.7) with Session 44 (main) corrections
**Date:** 2026-09-30
**Status:** Design accepted at Session 44 close. Committed to repo as source-of-truth
for future EF response-shape work.
**Supersedes:** ad-hoc shape choices per EF; consolidates the pattern that Session 44
hardening (`send-refund-notification`, commit `605b7c6`) established as intent.

---

## §1 Purpose & scope

Session 44 (main) surfaced repeated response-shape inconsistency across
`supabase/functions/`. Each individual case is small — different keys, different
HTTP status choices, different error nesting — but the aggregate creates:

- **Frontend integration friction** — every fetch site has to branch on the specific
  EF's shape idiom (`.error` vs `.ok` vs `.state` vs `.success`).
- **RUNBOOK example drift** — smoke examples differ per EF; no single `jq` pipe
  works across the fleet.
- **Post-deploy smoke fragility** — each smoke has to know its EF's idiosyncratic
  contract.

This doc establishes:

1. A **canonical response shape** for internal-caller EFs (§3).
2. The **hard exceptions** where external contracts dictate a different shape (§4).
3. A **per-EF migration plan** to move each drift instance onto canonical (§5).
4. A **testing procedure** for each shape change (§6).
5. A **rollout order + risk assessment** across Sessions 46 (pull-earlier fixes) and
   55 (canonicalization sweep) (§7).
6. **Unexpected findings** from the audit that fall outside shape-work proper (§8).

**Scope boundary.** This doc is design + implementation-plan. Landing spans multiple
sessions per §7. Frontend refactor for the fetch layer is out of scope beyond "fetch
site needs to update in atomic deploy with EF change."

**Session-numbering note.** Session 44.b's original draft slotted all migrations for
"Session 54." At Session 44 close, the pre-launch schedule was reordered: original
Session 55 (staging automation) moved to slot 45; original Session 45 (S-17 + S-08)
moved to slot 46; original Sessions 46-54 cascaded to slots 47-55. **The polish batch
formerly at Session 54 is now Session 55 in the new numbering** (see Roadmap Part IV.7
Session 44 DocUpdate for the full reorder). This doc uses the new numbering
throughout.

---

## §2 Full EF inventory + current-shape audit

Method: read every `supabase/functions/*/index.ts`; enumerate every `new Response(`
branch; catalogue HTTP status + body shape + emitting condition.

All EFs run with `verify_jwt = false` in `supabase/config.toml` (auth is inline per
EF). `_shared/duffel-helpers.ts` supplies one shared response constructor:
`checkModeKeyMismatch()` returns HTTP 503 with `{error: "Service temporarily
unavailable. Please try again shortly."}` — this is Family A shape.

### §2.1 Shape families observed

| Family | Shape | Currently used by |
|---|---|---|
| **A** | Errors: `{error: "<msg>"}` + extras; success: bare domain object | `alert-founder` (errors only), `check-offer-freshness`, `create-mpesa-stk` (errors + `success:true` wrap), `duffel-webhook` (errors), `get-baggage-options`, `get-offer` (errors + wrap; one shape bug), `get-seat-maps`, `get-user-trips`, `initialize-payment` (errors + wrap), `mint-guest-token`, `paystack-webhook` (errors), `process-duffel-booking` (errors), `retry-stuck-bookings`, `search-flights` (errors + wrap), `send-confirmation` (errors + wrap), `verify-payment` (infra errors only) |
| **B** | `{ok: bool, error?: string, ...}` | `audit-log` (fully), `heartbeat` (fully), `otp-precheck` (partial — 405 branch dropped the `ok` prefix) |
| **C** | Empty JSON `{}` on 200 | `send-otp` (Supabase Auth hook contract) |
| **D** | External-service shape | `mpesa-callback` (`{ResultCode, ResultDesc}`), `csp-report` (204 empty) |
| **E** | State-machine `{state, message, ...}` on 2xx | `payment-status`, `verify-payment` |
| **F** | Webhook-idiom plaintext `"ok"` on 200 success | `duffel-webhook`, `paystack-webhook`, `process-duffel-booking`, `send-refund-notification` (indirectly via `{status: "..."}`), `send-confirmation` OPTIONS |
| **G** | Rich `{success: true, ...meta}` wrapper on 200 | `alert-founder`, `create-mpesa-stk`, `get-offer`, `initialize-payment`, `search-flights`, `send-confirmation` |

Family G is a variant applied on top of Family A. The wrap decision is
inconsistent — some EFs bare-return the domain object (`get-user-trips` returns
`{trips:[...]}`), others wrap with `success:true` (`search-flights` returns
`{success:true, count, offers}`). The wrap adds a redundant field: HTTP 2xx
already signals success.

### §2.2 Per-EF matrix

Compact form. Each row: **auth model** (inline check), **caller type**, **2xx shapes**, **non-2xx shapes**. Line references in the audit-worksheet appendix (§App.A).

| # | EF | Auth | Caller | Success (2xx) | Errors (non-2xx) | External contract? |
|---|---|---|---|---|---|---|
| 1 | `alert-founder` | Service-role bearer, plaintext compare | Internal EFs, pg_cron | `{success:true, alert_type, email_sent, suppressed, suppression_reason, email_id}` (G) | 401 `{error:"Unauthorized"}`, 400 `{error:"Missing alert_type"}`, 500 `{error:<msg>}` (A) | No — internal only |
| 2 | `audit-log` | None inline (RLS-guarded) | Other EFs (fire-and-forget) | `{ok:true, id}` (B) | 405/400/500 `{ok:false, error:<msg>}` (B) | No — internal only. Callers do NOT read body (`_shared/duffel-helpers.ts` line 162 discards response) |
| 3 | `check-offer-freshness` | None (unauth) | Frontend browser | `{alive:true, expires_at, total_amount, total_currency}` (A) | 400/405/410/500/502 `{error:<msg>}` + extras (A) | No — frontend contract only |
| 4 | `create-mpesa-stk` | Optional JWT (guest fallback) | Frontend browser | `{success:true, merchant_ref, checkout_request_id, message, manual_paybill, breakdown}` (G) | 400/410/500/502 `{error:<msg>}` + extras (A) | Daraja outbound only; no consumer contract on our response |
| 5 | `csp-report` | None (unauth — browsers don't send auth on CSP reports) | Browser | 204 empty (D) | 204 empty on all failure paths (D) | **YES** — browser CSP spec; 204 empty required |
| 6 | `duffel-webhook` | HMAC-SHA256 (v1/v2) via `X-Duffel-Signature`, `DUFFEL_WEBHOOK_SECRET` | Duffel | Plaintext `"ok"` (F) | 400/401/500/503 `{error:<key>}` (A) | **YES (partial)** — Duffel retries on non-2xx; body shape not contractually constrained |
| 7 | `get-baggage-options` | None (unauth) | Frontend browser | `{baggages_by_passenger, free_baggages_by_passenger, free_baggages_summary, passengers, offer_currency, mode}` (A) | 400/500/503 `{error:<msg>}` (A) | No — frontend contract only |
| 8 | `get-offer` | Turnstile token (fail-open when secret unset) | Frontend browser | `{success:true, offer, selected_cabin, passengers_count}` (G) | 400/403/410/500/502 `{error:<msg>}` (A); **BUG:** L202 emits `{error:{message:"..."}}` — `error` value is an object, not a string |
| 9 | `get-seat-maps` | None (unauth) | Frontend browser | `{available:bool, slices:[...]}` or `{available:false, reason, slices:[]}` (A) | 400/410/500 `{error:<msg>}` (A) | No — frontend contract only |
| 10 | `get-user-trips` | JWT via `adminClient.auth.getUser(token)` | Frontend browser (signed-in) | `{trips:[...]}` (A) | 401/500 `{error:<msg>}` + `detail?` (A) | No — frontend contract only |
| 11 | `heartbeat` | None (unauth; cron-invoked) | pg_cron | `{ok:true, ran_at, stuck_row_count, cron_failure_count, healthchecks_ping_ok, notes}` (B) | 500 `{ok:false, error:<msg>}` (B) | No — cron logs consume only; `pingHealthchecks()` deliberately in try-body, absence-of-ping is the signal |
| 12 | `initialize-payment` | Optional JWT + Turnstile | Frontend browser | `{success:true, access_code, authorization_url, merchant_ref, pending_booking_id, guest_token, breakdown}` (G) | 400/403/409/410/500/503 `{error:<msg>}` + `code?`/`duffel_error?`/`expected_kes?` (A); **DRIFT:** L526–531 409 baggage/passenger mismatch has NO `code` field (siblings STALE_SEAT/STALE_BAGGAGE/PRICE_DRIFT all do) | No — frontend contract only |
| 13 | `mint-guest-token` | Constant-time SHA-256 compare of (pending_id, guest_token) pair | Frontend browser (anon) | `{token, expires_at}` (A) | 400/403/404/405/429/500 `{error:<msg>}` (A) | No — frontend contract only |
| 14 | `mpesa-callback` | **None (unauth) — no signature check on Daraja payload** | Safaricom Daraja | `{ResultCode:0, ResultDesc:"Accepted"}` on all handled paths (D) | 500 `{ResultCode:1, ResultDesc:"Transient claim error, retry"}` (D) — deliberately non-200 to trigger Daraja retry on transient DB failure; 503 delegated to `checkModeKeyMismatch` | **YES** — Daraja spec requires `{ResultCode:0, ResultDesc:"Accepted"}` at HTTP 200 for callback ACK; anything else triggers indefinite retry |
| 15 | `otp-precheck` | None (unauth) | Frontend browser | 200 `{ok:true, throttled:false}` / 200 `{ok:true, throttled:false, fallback:<reason>}` (B) | 429 `{ok:false, throttled:true, retry_after_minutes}` (B); **DRIFT:** 405 emits `{error:"method_not_allowed"}` bare (A, not B) | No — frontend contract only |
| 16 | `payment-status` | None (unauth) | Frontend browser (checkout poll + PNR self-service lookup) | `{state:<enum>, message, final?, raw_status?, merchant_ref?, breakdown?, booking?}` (E) | 400 `{error:"Missing ref"}`, 500 `{error:<msg>}` (A); 404 `{state:"not_found", message}` (E at 404); **DRIFT:** L185–190 emits `state:"not_found"` at HTTP 200 (missing explicit status), semantically should be 404 | No — frontend contract only |
| 17 | `paystack-webhook` | HMAC-SHA512 constant-time compare, `x-paystack-signature`, `PAYSTACK_API_KEY` | Paystack | Plaintext `"ok"` on ALL handled paths incl. malformed body, missing ref, idempotency bail, race lost (F) | 401 `{error:"Invalid signature"}` (A) — deliberately non-200 to signal untrusted payload (Paystack won't retry on 401); 500 `{error:"Transient DB error"}` on atomic claim failure — deliberately non-200 to trigger Paystack retry | **YES (status only)** — Paystack expects 200 on receipt; body ignored |
| 18 | `process-duffel-booking` | `x-webhook-secret` constant-time compare | DB webhook (pg_net), retry-stuck-bookings | Plaintext `"ok"` on all handled paths incl. race lost, terminal state, offer-dead (F) | 401 `{error:"Unauthorized"}`, 400 `{error:"Invalid payload"}`, 502 `{error:"Duffel network error"}`, 500 `{error:"Internal error"}` (A) — non-2xx used deliberately to trigger DB webhook retry | **YES (status only)** — pg_net retries on non-2xx |
| 19 | `retry-stuck-bookings` | `Authorization` bearer compare vs `SERVICE_ROLE_KEY` — **not constant-time** (comment acknowledges) | pg_cron | `{processed:<n>, results:[{id,ref,from_status,outcome,...}]}` (A) | 401 `{error:"Unauthorized"}`, 500 `{error:"Scan failed"}` / `{error:<msg>}` (A) | No — pg_cron logs only |
| 20 | `search-flights` | Turnstile (fail-open when secret unset) | Frontend browser | `{success:true, count, offers, filtered_reason, cabin_diagnostics}` (G) | 403/500/502 `{error:<msg>}` (A) | No — frontend contract only |
| 21 | `send-confirmation` | **None (no inline check)** — see §8.8 | `process-duffel-booking` (fire-and-forget) | `{success:true, email_id}` (G) | 400/500 `{error:<msg>}` (A); Resend passthrough at `res.status` with `{error: <resend json>}` | No — internal caller ignores response |
| 22 | `send-otp` | Standard Webhooks signature via `webhook-id/timestamp/signature` headers, `SEND_OTP_HOOK_SECRET` | Supabase Auth "Send SMS" hook | Empty JSON `{}` (C) on 200 — INCLUDING throttle-hit, delivery-failure, and outer-catch paths (Supabase Auth would abort sign-in on non-2xx) | 401 `{error:"invalid_signature"}` (A) — the sole non-2xx branch | **YES** — Supabase Auth hook contract; `{}` at 200 signals success to the hook |
| 23 | `send-refund-notification` | `x-webhook-secret` shared secret via `safeCompare` | DB webhook (refunds table trigger) | `{status:<enum>, branch?:<enum>}` (E-variant) — enums: `no_record`, `no_op_event`, `refund_not_found`, `already_sent`, `no_recipient`, `sent` | 401 `{error:"Unauthorized"}`, 500 `{error:"mail_config_error"}` / `{error:"unhandled"}`, 502 `{error:"resend_failed", resend_status}` (A) | No — DB webhook consumer ignores body |
| 24 | `verify-payment` | None (unauth) | Frontend browser (poll loop) | `{state:<enum>, message, booking?}` (E) — enums: `confirmed`, `processing`, `duffel_pending`, `failed`, `refund_pending`, `refunded`, `not_found` | 400 `{error:"Missing reference"}`, 500 `{error:"Lookup failed"}` / `{error:"Internal error"}`, 503 `{error:"Service temporarily unavailable..."}` (A) | No — frontend contract only. TS union type declares `needs_support` state but no branch emits it |

**Read-only reference: `_shared/duffel-helpers.ts` shared constructors**

- `CORS_HEADERS`: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers:
  authorization, content-type, x-paystack-signature, x-webhook-secret`.
- `checkModeKeyMismatch(source)`: returns 503 with `{error: "Service temporarily
  unavailable. Please try again shortly."}` (Family A). Used by 5+ EFs.
- `alertFounder`, `auditLog`: outbound helpers, not response constructors.
- `refundBooking`: DB-write helper, not response constructor.

---

## §3 Canonical shape proposal

### §3.1 Decision

**Canonical A** — for the general internal-caller and frontend-caller EFs.

```
# Preflight (OPTIONS)
HTTP 200 plaintext "ok" with CORS_HEADERS
(or HTTP 204 empty — both acceptable; prefer whichever is already present)

# Error (any non-2xx status)
HTTP <status>
{
  "error": "<human-readable string>",
  "code"?: "<STABLE_MACHINE_CODE>",
  ...context (e.g. duffel_error, retry_after_minutes, expected_kes)
}

# Success (2xx)
HTTP 200 (or 201/204 where semantically appropriate)
{
  ...domain_keys
}
```

**Canonical B** — for state-machine EFs whose HTTP status does not carry the
domain semantic (`payment-status`, `verify-payment`, `send-refund-notification`).

```
# All 2xx responses
{
  "state": "<enum_value>",     # or "status", for the internal DB-webhook EF
  "message"?: "<human-readable string>",
  ...context (e.g. booking, breakdown, merchant_ref, branch)
}

# Infrastructure errors (non-2xx)
{
  "error": "<msg>",
  "code"?: "..."
}
```

### §3.2 Rules

1. **`error` is always a string.** Never `{error: {...}}`. `code` (optional) is the
   machine-parseable stable slug in SCREAMING_SNAKE.
2. **HTTP status is the primary success signal.** Frontend and internal callers
   branch on `response.ok` (the HTTP layer), not on a body field like
   `{ok: bool}` or `{success: true}`.
3. **Success bodies do NOT wrap with `{success: true, ...}` by default.** The wrapper
   is redundant with HTTP 2xx. Existing EFs that carry `success: true` (Family G)
   are targets for the migration (§5), except where the wrapper carries a
   distinct business signal (`alert-founder` uses it to distinguish "sent vs
   suppressed by dedup" — that stays).
4. **404 emits `{error: "Not found"}` at HTTP 404** for the general case. State-machine
   EFs may emit `{state: "not_found", message: "..."}` at 404 as a Canonical B
   variant — the state carries the enum, HTTP 404 carries the status.
5. **Empty domain payload → still a bare object, not plaintext.** Success 200 with
   no useful domain fields returns `{}`, not the string `"ok"`. (The exception is
   webhook-idiom EFs in §4.)

### §3.3 Why not Family B (`{ok: bool}`)?

Family B's argument: `ok: false` at HTTP 200 is useful when an external contract
requires 200-with-error-shape (e.g., Daraja). **The counter:** that is a specific
external-contract carveout (Family D), not a reason for the internal fleet to
adopt a redundant signal.

Concrete costs of Family B in the fleet today:

- **Double signal drift:** callers may key off HTTP status OR `.ok` field. Two
  sources of truth → branch bugs. `otp-precheck` L61 is a live example: 405
  emits `{error: "method_not_allowed"}` with no `ok` prefix, breaking its own
  family within the same file.
- **No consumer reads it:** `_shared/duffel-helpers.ts` `auditLog()` fire-and-forgets
  the response entirely (line 162). `heartbeat`'s response is consumed only by
  pg_cron logs. `otp-precheck` frontend caller (search of `frontend/index.html`
  found no direct fetch — Session 44 investigation confirmed; see §8.4).
  Zero consumers rely on the `.ok` field being present.
- **`jq` inconsistency:** `.error // .` works for Family A. For Family B a
  RUNBOOK curl example has to do `.error // (.ok | not) | ...`. Every smoke
  script has to know the family per EF.

**Recommendation:** Migrate `audit-log`, `heartbeat`, and `otp-precheck` to
Canonical A. Alignment cost is small (each EF is <20 LOC of response
construction), and it removes the field entirely from operator vocabulary.

### §3.4 Why not Family G (`{success: true, ...}` wrapper)?

Callers that check `.success` today have redundant guards over `response.ok`.
Removing the wrapper is a one-line change per EF (drop `success: true,` from
the JSON body) plus a matching one-line frontend change (drop `if (!data.success)`
guard, key off `res.ok` alone).

`alert-founder` retains `success: true` because its `success` field carries a
distinct meaning from HTTP status: `success: true, suppressed: true` says "we
processed the request and chose to suppress the email" — HTTP 200 alone cannot
convey suppressed-vs-sent. That is a business signal, not a redundant status
echo, and it stays.

`send-confirmation` returns `{success: true, email_id}` — the `email_id` is the
useful field for correlation; the `success: true` wrapper is redundant. Migrate
to bare `{email_id}`.

---

## §4 Hard exceptions (do NOT change)

External contracts dictate these shapes. The design MUST carve them out and
never propose migration.

| EF | Required shape | Rationale |
|---|---|---|
| `send-otp` | HTTP 200 `{}` on all non-signature-failure paths | Supabase Auth "Send SMS" hook contract. Non-2xx or non-empty error body would cause Supabase Auth to reject sign-in. The 401 `{error:"invalid_signature"}` branch is the sole permitted deviation (rejects mis-signed requests before the hook contract applies). |
| `mpesa-callback` | HTTP 200 `{ResultCode:0, ResultDesc:"Accepted"}` on ACK | Safaricom Daraja spec. Non-conforming ACK triggers indefinite Daraja retry. The deliberate 500 `{ResultCode:1, ResultDesc:"Transient claim error, retry"}` at L235–238 is the ONLY path that uses non-2xx, and is intentional (retries Daraja when a transient DB failure blocks progress after payment was already confirmed). |
| `csp-report` | HTTP 204 empty on all paths | Browser CSP `report-uri` spec. Non-2xx triggers no useful browser behavior; non-empty body is ignored. Rate-limit-drop, malformed-body, DB-write-failure all still return 204 by design. |
| `paystack-webhook` | HTTP 200 on all handled receipts | Paystack retries on non-2xx. Body shape is not contractually constrained (Paystack ignores body). The current use of plaintext `"ok"` on 200 and `{error:...}` on 401/500 is **compatible with the contract** and does not need migration — but note that the 401 on signature failure is a **deliberate** non-2xx to prevent Paystack retrying an untrusted payload, and the 500 on atomic-claim failure is a **deliberate** non-2xx to trigger retry when the DB briefly cannot advance state after payment confirmed. |
| `duffel-webhook` | 2xx on receipt (any body) | Duffel retries on non-2xx. Same pattern as Paystack — plaintext `"ok"` on 200 happy paths, `{error:...}` on 401 signature failure (deliberately non-2xx to reject untrusted payload) and 500 (deliberately non-2xx to trigger Duffel retry with idempotency guards). No migration needed. |
| `process-duffel-booking` | 2xx on receipt when state is safe or terminal; 5xx when DB-webhook retry is desired | pg_net (Supabase DB webhook) retries on non-2xx. Same pattern — plaintext `"ok"` on 200 happy paths, `{error:...}` on 401/400/500/502. The distinction "return 200 to prevent retry" vs "return 5xx to trigger retry" is a documented invariant (see comments in the EF). No migration. |
| `send-refund-notification` | 2xx on receipt (DB webhook); body shape not contractually constrained | pg_net retries on non-2xx. Body shape is a Canonical B variant (`{status: "sent"|"no_op_event"|...}`) that is useful for pg_net log tracing. Migration would be cosmetic; the shape is already Canonical-B-compatible and consumers ignore it. **Recommend leave as-is.** |

**Family F (webhook plaintext `"ok"`)** is not a "family" so much as an artifact
of webhook-idiom terseness. It is compatible with Canonical A (HTTP 200 is the
signal; body is unread). Do not migrate the webhook EFs' 200 bodies to
`{success: true}` or `{}` — the plaintext `"ok"` is fine, and touching those
paths risks Duffel/Paystack integration for zero gain.

---

## §5 Migration plan per EF

Grouped by risk tier + landing session. Each entry lists: **current → target**,
**impact**, **estimated LOC**, **landing session**.

**Session assignment rationale.** Session 44.b's original draft slotted every
item into old Session 54 (now Session 55). Session 44 (main) review pulled
bug-fix and hardening items forward to Session 46 (legal batch + Framework
consistency pass — already open to receive small opportunistic fixes). Session 55
retains only pure cosmetic canonicalization.

### §5.1 Pull-earlier items — Session 46 (legal batch + fold-ins)

Live bugs, hardening items, and KYC-truthfulness closers.

| # | EF | Current | Target | Impact | LOC | Rationale |
|---|---|---|---|---|---|---|
| 1 | `get-offer` L202 | 502 `{error:{message:"Could not reach Duffel..."}}` | 502 `{error:"Could not reach Duffel — please retry"}` | **Live bug.** Frontend reads `.error` as string; the object case surfaces as `[object Object]` in the toast. | 1 line | User-facing bug fix; too small to justify its own session, folds cleanly into 46. |
| 2 | `initialize-payment` L526-531 | 409 baggage/passenger mismatch has no `code` field | Add `code: "STALE_BAGGAGE_PASSENGER"` | Additive; siblings STALE_SEAT/STALE_BAGGAGE/PRICE_DRIFT all have `code`. | 1 line | Consistency + enables cleaner frontend branching. Trivial. |
| 3 | `send-confirmation` inline auth check | No inline check of Authorization header (§8.8) | Add `SERVICE_ROLE_KEY === Authorization` compare (matches `alert-founder` pattern) | Hardening. Anyone with anon key currently could trigger Resend dispatch. Spam + rate-limit vector. | ~5 LOC | Real security hardening; belongs in Session 46 rather than Session 55 polish. |
| 4 | Wire `otp-precheck` into frontend | Not called from any frontend fetch site (§8.4 confirmed Session 44) | Add fetch call before every `sb.auth.signInWithOtp()` and `sb.auth.updateUser({phone})` site. Handle 200 (proceed), 200-fallback (proceed, fail-open per design), 429 (show throttle error). | KYC 1.16 per-IP truthfulness. Without this, per-IP throttle is claimed but not enforced. | ~10-20 LOC frontend | Closes KYC 1.16 truthful pass for Session 46 legal batch to James. |

### §5.2 Cleanup opportunistic — Session 49 (retry-stuck-bookings unpause)

Trivial hardening that piggybacks on an EF already being touched.

| # | EF | Current | Target | Impact | LOC | Rationale |
|---|---|---|---|---|---|---|
| 5 | `retry-stuck-bookings` L500-503 | `Authorization` bearer compared with `!==` (non-constant-time; comment acknowledges) | Constant-time compare matching `mint-guest-token` pattern | Timing-attack surface minimal (attacker would need internal caller access already), but trivially fixable. | ~3 LOC | Session 49 is already opening this EF for the cron-unpause work. Land as sibling commit. |

### §5.3 Session 55 canonicalization sweep

Pure cosmetic shape migration where nothing is broken and no user is affected.
Bundle into one Session 55 sweep for context efficiency.

| # | EF | Current | Target | Frontend impact | LOC (EF + frontend) |
|---|---|---|---|---|---|
| 6 | `audit-log` | `{ok:true, id}` / `{ok:false, error}` | `{id}` / `{error}` at appropriate HTTP status | None — `_shared/duffel-helpers.ts` `auditLog()` fire-and-forgets response body (line 162). No consumer reads `.ok` or `.id`. | ~15 EF + 0 frontend |
| 7 | `heartbeat` | `{ok:true, ran_at, ...}` / `{ok:false, error}` | `{ran_at, stuck_row_count, ...}` / `{error}` at 500 | None — consumed by pg_cron logs only; RUNBOOK curl examples update. | ~10 EF + 0 frontend |
| 8 | `send-confirmation` drop `success: true` wrapper | 200 `{success:true, email_id}` | 200 `{email_id}` | Fire-and-forget caller (`process-duffel-booking`) does not read response body. Bundle with the auth-check fix from §5.1 into one commit. | 1 line EF + 0 frontend |
| 9 | `create-mpesa-stk` | 200 `{success:true, merchant_ref, ...}` | 200 `{merchant_ref, ...}` | No live fetch site (M-Pesa UI hidden/disabled per §8.3). Preemptive migration. | 1 line EF + 0 frontend |
| 10 | `search-flights` | 200 `{success:true, count, offers, ...}` | 200 `{count, offers, ...}` | Frontend `frontend/index.html` L13556 fetch site. Remove `.success` guard. Highest-traffic EF; atomic backend + frontend deploy. | 1 EF + 1 frontend |
| 11 | `get-offer` (drop `success: true`) | 200 `{success:true, offer, ...}` | 200 `{offer, selected_cabin, passengers_count}` | Frontend `frontend/index.html` L10352, L10670, L10706 fetch sites. Remove `.success` guards. Lands AFTER §5.1 item 1 bug fix. | 1 EF + 3 frontend |
| 12 | `initialize-payment` (drop wrapper) | 200 `{success:true, access_code, ...}` | 200 `{access_code, ...}` | Frontend L19403. Paystack InlineJS reads `access_code` directly; no `.success` read today. | 1 EF + 1 frontend |
| 13 | `otp-precheck` (Canonical A shape) | 200/429 with `{ok: bool, throttled: bool, ...}` (B); 405 drift | 200 `{throttled:false}` (+ `fallback?`) / 429 `{throttled:true, retry_after_minutes}` / 405 `{error:"Method not allowed"}` (Canonical A) | Frontend integration from §5.1 item 4 will be built against Canonical A shape directly. Sequencing: §5.1 item 4 lands Session 46; if it lands before Session 55 (likely), Session 55's §5.2 migration is a no-op. | ~15 EF (or 0 if Session 46 already landed Canonical shape) |
| 14 | `payment-status` L185-190 | Emits `state:"not_found"` at HTTP 200 (implicit) | Emit `state:"not_found"` at HTTP 404 | Frontend L24469 (PNR lookup) reads `.state`; changing HTTP 200 → 404 means `res.ok` becomes `false`. Frontend must branch on `.state === "not_found"` regardless of `res.ok`. The PNR path at L129-135 already uses 404 with `state:"not_found"`; the L185-190 checkout-poll path is the drift. | 1 line EF + verify frontend handles 404 |
| 15 | `verify-payment` | TS union type declares `needs_support` state but no branch emits it | Either remove the state (dead-code cleanup) OR wire it to `pending.status === "amount_mismatch"` cases currently returned as `"failed"` | Requires support-workflow decision. Session 55 or when refund/support tooling matures. | Depends on design decision |

### §5.4 EFs already on canonical (no change)

- `check-offer-freshness` — Canonical A throughout.
- `get-baggage-options` — Canonical A, bare success object.
- `get-seat-maps` — Canonical A, bare success object.
- `get-user-trips` — Canonical A, bare success object.
- `mint-guest-token` — Canonical A throughout.
- `retry-stuck-bookings` — Canonical A, bare `{processed, results}` (see §5.2 for
  the separate auth-hardening item).
- `process-duffel-booking` — errors on Canonical A; success uses webhook-idiom
  plaintext `"ok"` (Family F, acceptable per §4).
- `duffel-webhook`, `paystack-webhook` — same as process-duffel-booking (Family F
  acceptable).
- `mpesa-callback` — Family D (hard exception, §4).
- `send-otp` — Family C (hard exception, §4).
- `csp-report` — Family D (hard exception, §4).
- `send-refund-notification` — Canonical B variant (`{status, branch}`),
  acceptable per §4.
- `payment-status` — Canonical B on success paths; §5.3 item 14 fixes the L185-190
  drift.
- `alert-founder` — Family G (`success: true`) retained per §3.4 (business signal,
  not redundant).

### §5.5 Migration commit-size summary

- **Session 46 fold-in (§5.1):** 4 items × 1-20 LOC = ~30 LOC + ~10 frontend LOC.
  Estimated 1-2h of Session 46 alongside legal deliverables.
- **Session 49 opportunistic (§5.2):** 1 item, ~3 LOC. Sibling commit, ~15 min.
- **Session 55 sweep (§5.3):** 10 items × 1-15 LOC = ~40 LOC EF + ~5 LOC frontend.
  Estimated 2h of Session 55 assuming smoke coverage keeps up.

**Grand total across all sessions: ~55-70 LOC.**

---

## §6 Testing procedure per shape change

For every migration in §5, the smoke suite must verify:

1. **New shape returned.** Curl the EF with a happy-path payload; `jq` the
   response; assert every expected key and no legacy key remains. Example:

   ```bash
   curl -sS -X POST "$SUPABASE_URL/functions/v1/audit-log" \
     -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"actor_type":"system","action_type":"smoke","target_type":"pending_booking","target_id":"00000000-0000-0000-0000-000000000000"}' \
     | jq -e '.id and (.ok | not) and (has("ok") | not)'  # id present, ok field absent
   ```

2. **HTTP status unchanged (or if changing, both status + shape verified together).**
   `curl -w "%{http_code}"` and assert both.

3. **Alerting still fires correctly.** If the EF's error path calls `alertFounder`,
   run a failure-path smoke and verify a row appears in `alerts` with the expected
   `alert_type` and `dedup_key`. This applies to: `initialize-payment` (PRICE_DRIFT
   / STALE_SEAT / STALE_BAGGAGE / STALE_BAGGAGE_PASSENGER), `mpesa-callback`
   (PAYMENT_FAILED / AMOUNT_MISMATCH / PAID_NO_OFFER / PAID_NO_TICKET),
   `paystack-webhook` (same set), `send-refund-notification` (WEBHOOK_SECRET_MISMATCH).

4. **Frontend still works.** For every Tier 2 EF, run the affected user flow
   locally (search → book → pay → confirm) and confirm no console error and no
   UI regression. Playwright coverage should already exist for the checkout
   path; extend for any newly-added state.

5. **External-contract EFs — DO NOT retest by changing shape.** For the Family
   D exceptions (§4), no smoke exercises the shape change because there is no
   shape change. Continue to verify the contract shape is emitted (existing
   smoke does).

---

## §7 Rollout order + risk assessment

### Phase 1 — Session 46 (already open for legal batch + fold-ins)

Land in this order, one commit per EF where possible:

1. `get-offer` L202 bug fix (`{error:{message:...}}` → `{error:"..."}`).
2. `initialize-payment` L526-531 add `code: "STALE_BAGGAGE_PASSENGER"`.
3. `send-confirmation` inline `SERVICE_ROLE_KEY` auth check (see §8.8).
4. Wire `otp-precheck` into frontend (see §8.4). This is the KYC 1.16
   truthfulness closer — must land before or with the KYC v1.4 rev going to
   James in the same session.

Deploy to A3 via `staging` branch (once Session 45 automation is live). Smoke
each per §6. Promote to prod when green.

### Phase 2 — Session 49 (retry-stuck-bookings unpause)

Land as sibling commit alongside the cron unpause work:

5. `retry-stuck-bookings` constant-time auth compare.

### Phase 3 — Session 55 canonicalization sweep

Ordered by risk within the session:

**Backend-only (LOW risk, no frontend coordination):**
6. `audit-log` drop `ok:` prefix.
7. `heartbeat` drop `ok:` prefix.
8. `send-confirmation` drop `success: true` wrapper (bundle with §5.1 item 3 auth check if not already shipped).
9. `create-mpesa-stk` shape migration (preemptive; UI still hidden).
10. `verify-payment` `needs_support` state decision (remove or wire — requires design decision).

**Frontend-coordinated (MEDIUM risk, atomic commits):**
11. `search-flights` — highest-traffic EF; wrapper removal with no state-machine impact.
12. `get-offer` wrapper removal (after §5.1 item 1 bug fix has been shipped).
13. `initialize-payment` wrapper removal.
14. `payment-status` 200-not-found → 404 (highest impact of Session 55 items).
15. `otp-precheck` shape (no-op if Session 46 already landed Canonical A shape per §5.3 item 13 note).

### Phase 4 — Documentation cleanup (Session 55 or later)

- Remove `[functions.pesapal-webhook]` orphan from `supabase/config.toml`
  (see §8.1).
- RUNBOOK §17 or equivalent smoke-recipe section: fold in Canonical A/B curl
  examples so operators have a single shape reference.

### Risk assessment matrix

| Phase | Risk | Rollback strategy |
|---|---|---|
| Phase 1 (Session 46) | LOW | Each item is small and independently revertable. §5.1 item 3 auth check is the highest impact — revert restores today's fail-open behavior. §5.1 item 4 otp-precheck wire is frontend-only additive; revert restores pre-throttle behavior (per-phone still enforced downstream). |
| Phase 2 (Session 49) | LOW | Constant-time compare is functionally equivalent; revert restores identical behavior with theoretical timing signal. |
| Phase 3 (Session 55) | LOW-MEDIUM | Backend-only items: revert commit; alerts unaffected. Frontend-coordinated: revert atomic commit (backend + frontend together). Frontend `.success` guard removal is idempotent (checking `.success === undefined` is safe on either shape). |
| Phase 4 | LOW | `config.toml` change is trivially reversible; RUNBOOK doc reversion trivial. |

**No payment-path smoke can be skipped.** For Phase 3 items 11-14, the A3 preview
URL smoke procedure (as documented in `docs/security/a3_e2e_webhook_simulation.md`
or `smoke_test.md §8` depending on Session 52 cutover state) must be executed
before promoting to prod.

---

## §8 Unexpected discoveries

Findings surfaced by the audit that are outside the shape design proper. Each
tagged with severity + current disposition.

### §8.1 `pesapal-webhook` EF referenced in `supabase/config.toml` but no folder exists — **LOW severity, docs hygiene**

`supabase/config.toml` declares `[functions.pesapal-webhook]` with
`verify_jwt = false`, but `ls supabase/functions/ | grep pesapal` returns
nothing. Legacy config from a superseded payments-provider evaluation
(Pesapal was investigated as a Paystack alternative earlier).

**Disposition:** Remove the config stanza in Session 55 Phase 4 documentation
cleanup.

### §8.2 `link-booking-user` EF called by frontend but folder does not exist — RESOLVED Session 44

Session 44.b flagged this as HIGH severity production silent-failure. Session 44
(main) investigated and resolved.

**Investigation (Session 44 main, 2026-09-30):**
- Git blame confirmed the frontend fetch site was introduced by commit `42f1a9e`
  (Phase 4.6 user-accounts UI + config).
- The EF folder was never committed to git (`git log --all` returned empty for
  `supabase/functions/link-booking-user/*`).
- Every guest → signed-in transition post-Phase-4.6 silently 404'd; try/catch
  swallowed the failure, console.warn logged it, nothing else broke.
- Bev confirmed the historical product decision: guest bookings are intentionally
  NOT retroactively associated with user accounts created post-booking. Users
  retrieve guest bookings via the PNR + surname + email self-service path
  ("Find my booking"), consistent with industry OTA norms (Booking.com, Expedia,
  Kiwi).

**Action taken:** Commit `e31f612` on `main` deleted the frontend
`linkBookingToUser` function (was L23196-L23205) and the wiring in
`openAuthModal` (was L22644-L22646). The generic `authCallback` mechanism
(L21756, L22304, L22710) was retained — null-guarded and available for future
post-sign-in nudges without redesigning the plumbing.

**Documentation trail:** Commit message on `e31f612` carries the full rationale.
Session 44 close bundle (Running Updates Log) records the decision. KYC v1.4
rev in Session 46 legal batch to James will name this design choice explicitly.

### §8.3 M-Pesa pay tab is `hidden` and `disabled` in the frontend — **INFO, expected**

`frontend/index.html` L8141-8142 shows the M-Pesa pay tab is intentionally
hidden and disabled. Consistent with the Roadmap sequencing (M-Pesa enablement
scheduled post-Paystack cutover). No action needed; noted so that §5.3
item 9's `create-mpesa-stk` migration is understood as preemptive.

### §8.4 `otp-precheck` has no direct frontend fetch site — INVESTIGATED Session 44

**Investigation (Session 44 main, 2026-09-30):**
- `grep -n "otp-precheck\|otpPrecheck\|otpprecheck" frontend/index.html` → zero
  matches. Confirmed no frontend fetch site.
- `grep -rn "functions.invoke.*otp\|invoke.*otp-precheck"` → zero server-side
  invocations from any EF.
- `send-otp/index.ts` grep for `scope|ip|throttle|window|LIMIT`: throttle logic
  is per-phone only. Header comment at L23 explicitly says "S-07c per-phone
  throttle (KYC 1.16)". Constants `PHONE_WINDOW_15M_LIMIT` and
  `PHONE_WINDOW_24H_LIMIT`. All DB scope queries use `"phone"`. **No per-IP
  scope logic exists in send-otp.**

**Finding:** The per-IP dimension of KYC 1.16's "OTP request throttling per-phone
AND per-IP" claim is currently NOT enforced anywhere. Per-phone is enforced by
`send-otp` inline; per-IP was designed for `otp-precheck` (which can see the
client IP; `send-otp` cannot because it is called server-to-server by Supabase
Auth). The frontend wire-up was never landed.

**Design rationale for the split:**
- `otp-precheck` is invoked by the client; sees the original client IP via
  `cf-connecting-ip` / `x-forwarded-for`. Can do per-IP.
- `send-otp` is called by Supabase Auth via the Send SMS hook (server-to-server).
  Sees Supabase's server IP, not the client's. Cannot do per-IP correctly.

**Fix scheduled Session 46:** Wire `otp-precheck` fetch site into the frontend
before every `sb.auth.signInWithOtp()` and `sb.auth.updateUser({phone})` call
site. Handle three response states:
- `200 {throttled: false}` → proceed with Supabase Auth call
- `200 {throttled: false, fallback: "..."}` → proceed (fail-open per design)
- `429 {throttled: true, retry_after_minutes}` → show throttle error, don't call

On landing, KYC 1.16 becomes truthful and can flip in the KYC v1.4 rev going to
James in the same Session 46.

### §8.5 `verify-payment` declares `needs_support` state but never emits it — **LOW severity, cleanup**

Already covered in §5.3 item 15. Session 55 decision: either wire to
`amount_mismatch` cases (adds a support-workflow state) or delete the reserved
state (dead-code cleanup).

### §8.6 `alert-founder` echoes caller-provided `alert_type` — **LOW severity, data quality**

`alert-founder/index.ts` L521-530: on success, the response `alert_type` field
echoes the CALLER-PROVIDED value, not the `effectiveType` derived internally.
If a caller sends an unknown alert type, the response echoes the unknown
string back. Not a shape issue, but a data-quality concern: consumers using
the response for logging would log unknown types indistinguishable from known
ones. Consider echoing `effectiveType` (or both) in Session 55.

### §8.7 `retry-stuck-bookings` auth check is not constant-time — **LOW severity, hardening**

Already covered in §5.2. Land in Session 49 as sibling commit to cron-unpause work.

### §8.8 `send-confirmation` has no inline auth check — **MEDIUM severity, real hardening item**

The EF is invoked by `process-duffel-booking` and `mpesa-callback` with
`Authorization: Bearer ${SERVICE_ROLE_KEY}`, but the EF itself does not
validate the header (unlike `alert-founder` which does the compare inline).
`verify_jwt = false` in `config.toml`, so Supabase does not gate the call
either. **Anyone with the anon key can call `send-confirmation` today** and
trigger a Resend email dispatch. Rate-limit risk (Resend cost) plus spam
vector.

**Fix scheduled Session 46 (§5.1 item 3):** Add inline `Authorization ===
SERVICE_ROLE_KEY` check matching `alert-founder` pattern. ~5 LOC.

---

## §App.A Line-number appendix

Per-EF line references for the response constructions catalogued in §2.2.
Included so future maintainers can trace shape decisions back to the actual
source without re-running the audit.

- **alert-founder** — L382 (OPTIONS 200 plaintext), L394-399 (401), L406-411
  (400 missing alert_type), L521-530 (200 success rich), L532-538 (500 catch).
- **audit-log** — L99-104 (405), L107-114 (400 invalid JSON), L116-122 (400
  validate), L137-145 (500 insert error), L124-150 (200 success `{ok:true,id}`).
- **check-offer-freshness** — L54-56 (OPTIONS 200 plaintext), L58-63 (405),
  L65-71 (500 config), L73-81 (400 JSON), L83-89 (400 offer_id regex), L116-128
  (502 network), L135-149 (410 duffel non-2xx), L151-161 (502 malformed
  response), L163-172 (410 expiring), L174-182 (200 success).
- **create-mpesa-stk** — L81-83 (OPTIONS), L109-114 (400), L117-124 (400 phone),
  L136-144 (410 offer non-2xx), L148-155 (410 expiring), L215-234 (502 Daraja
  non-zero), L246-264 (200 success), L266-272 (500 catch).
- **csp-report** — L77-79 (OPTIONS 204), L80-82 (405 empty), L94-98 (204 rate
  limit), L108-113 (204 body throw), L114-116 (204 empty body), L149-151 (204
  JSON parse), L227 (204 success).
- **duffel-webhook** — L421 (OPTIONS "ok"), L434 (400 body_read_failed), L465
  (401 signature), L486 (400 invalid_json), L502 (503 live_mode_mismatch), L539
  (500 internal_error). Many "ok" plaintext paths per event type; enumeration
  in original audit block.
- **get-baggage-options** — L121 (OPTIONS), L138 (503 mode-key), L149 (400),
  L167-194 (200 soft-degrade shapes), L315 (200 happy path), L328 (500 catch).
- **get-offer** — L162 (OPTIONS), L168 (400), L179 (403 Turnstile), L202 (502
  network — **shape bug**), L214 (410/502 Duffel status branch), L228 (502
  malformed), L239 (410 expired), L370 (200 success), L379 (500 catch).
- **get-seat-maps** — L104 (OPTIONS), L110 (400), L130/139 (200 unavailable),
  L156 (410), L258 (200 success), L264 (500 catch).
- **get-user-trips** — L27 (OPTIONS 204), L36 (401 no bearer), L49 (401 auth
  fail), L96 (500 DB), L252 (200 success), L259 (500 catch).
- **heartbeat** — L288-298 (200 success rich `ok:true`), L319-322 (500 catch
  `ok:false`).
- **initialize-payment** — L237 (OPTIONS), L125-128 (503 mode-key), L269-272
  (400 missing), L278-281 (400 email), L288-291 (400 phone), L300-305 (403
  Turnstile), L318-324 (410 offer non-2xx), L329-334 (410 expiring), L370-379
  (409 PRICE_DRIFT), L405-411 (409 STALE_SEAT), L440-446 (409 STALE_SEAT
  designator), L508-514 (409 STALE_BAGGAGE), L526-531 (409 no code —
  **drift**), L662-679 (200 success), L700-703 (500 catch).
- **mint-guest-token** — L110 (OPTIONS), L114 (405), L122 (400 JSON), L128
  (400 UUID), L131 (400 hex), L143 (500), L149 (404), L155-157 (429 threshold),
  L165 (500 NULL token), L198 (403 mismatch), L223-226 (200 success),
  L229 (500 sign).
- **mpesa-callback** — L82 (OPTIONS), L60-63 (503 mode-key), L97/106/129/138/
  165/195/243/275/389/561/575 (200 `darajaAck` on various paths), L235-238
  (500 `{ResultCode:1, ...}` for transient claim error).
- **otp-precheck** — L58 (OPTIONS 204), L61 (405 `{error:...}` — **drift**),
  L92 (200 fail-open infra), L109-112 (429 throttled), L133 (200 fail-open
  insert), L136 (200 success), L140 (200 fail-open outer catch).
- **payment-status** — L66 (OPTIONS), L98-101 (400 missing ref), L129-135
  (404 PNR DB error), L150-156 (404 PNR mismatch), L162-169 (200 PNR
  confirmed), L185-190 (200 not_found — **drift, should be 404**), L196-232
  (200 checkout-poll state), L236-239 (500 catch).
- **paystack-webhook** — L480 (OPTIONS), L484 (checkModeKeyMismatch delegate),
  L513 (200 plaintext on malformed body), L533-536 (401 signature), L559/579/
  609/622/660/682/730/766/776 (200 plaintext on all handled paths), L722-725
  (500 transient claim), L792-795 (500 catch).
- **process-duffel-booking** — L152 (OPTIONS), L181-184 (401), L189
  (checkModeKeyMismatch delegate), L199-202 (400 invalid payload), L230/235/
  306/321/485/508/527/569/583/762/768/779/843/871 (200 plaintext on all
  handled paths), L452-455 (502 network), L881-884 (500 catch).
- **retry-stuck-bookings** — L493 (OPTIONS), L505-508 (401), L513
  (checkModeKeyMismatch delegate), L557-560 (500 scan), L571-574 (200 no
  rows), L583-586 (200 rows processed), L600-603 (500 catch).
- **search-flights** — L210 (OPTIONS), L234-239 (403 Turnstile), L260-263
  (502 all cabins empty), L484-498 (200 success), L500-504 (500 catch).
- **send-confirmation** — L488 (OPTIONS), L509-517 (400), L540-564 (Resend
  passthrough), L582-584 (200 `{success:true, email_id}`), L586-604 (500
  catch).
- **send-otp** — L99-103 `OK()` helper (200 `{}`); L113-116 (200 no secret),
  L123-129 (401 signature), L138-141/152-163/165-176/207-219/221-237/237/
  239-242 (200 `{}` on all subsequent branches per Auth hook contract).
- **send-refund-notification** — L239 (OPTIONS), L243-271 (401), L277-282
  (200 no_record), L294-299 (200 no_op_event), L321-327 (200 refund_not_found),
  L329-334 (200 already_sent), L337-343 (200 no_recipient), L364-370 (500
  mail_config_error), L392-399 (502 resend_failed), L410-413 (200 sent),
  L414-419 (500 unhandled).
- **verify-payment** — L124-126 (OPTIONS), L128-129 (503 mode-key, local
  variant with `PAYSTACK_MODE_KEY_MISMATCH` alert), L143-148 (400 missing ref),
  L158-164 (500 lookup), L165-171 (200 not_found), L174-184 (200 confirmed),
  L186-190 (200 failed), L192-196 (200 failed amount_mismatch), L200-204/205-209
  (200 refund_pending / refunded), L211-220 (200 refund_pending offer/booking
  failed), L223-227 (200 processing paid/booking), L236-240 (200 duffel_pending),
  L262-269 (200 processing Paystack non-2xx), L272-277 (200 processing Paystack
  success bookings not yet advanced), L278-325 (200 failed after Paystack
  failed/abandoned/reversed), L329-331 (200 processing catchall), L333-348
  (500 catch).

---

**End of design doc.** Source-of-truth for future EF response-shape work.
Session 46 owns §5.1 pull-earlier fixes; Session 49 owns §5.2 opportunistic
hardening; Session 55 owns §5.3 canonicalization sweep.
