# audit_log — attestation

**Location:** `docs/security/audit_log_attestation.md`
**Framework Doc reference:** Appendix C, entry for `audit_log_attestation.md`; §5 "Alerting and audit"
**Owner:** Data Protection Officer (as of Session 41); Operations / Security engineering post-hire.
**Status:** shipped and verified.

---

## 1 — Purpose and scope

The `audit_log` table is TumaFly's comprehensive per-action audit trail for the payment-and-booking lifecycle. It complements the operationally-focused `alerts` table (which captures anomaly-driven notifications with dedup and email delivery) by capturing every meaningful step every payment-or-booking Edge Function takes against a specific record — successful and unsuccessful alike, whether or not the step is anomaly-worthy.

The design intent under DPA 2019 §41:

- **Forensic reconstruction.** Any booking can be reconstructed after the fact by querying the `target_id` index: `SELECT * FROM audit_log WHERE target_type = 'pending_booking' AND target_id = '<uuid>' ORDER BY created_at`. The full lifecycle of the booking's payment initialization, capture, order creation, verification, confirmation email, and (if applicable) refund lands as ordered rows.
- **Manual-ops accountability.** Operator-initiated interventions (e.g. a manual refund actioned via the payment processor console rather than the automated pipeline) are recorded under a distinguishing `actor_id` convention (`manual-ops-<initials>`) so ops actions are unambiguously distinguishable from Edge Function actions.
- **Retention supporting DPA §43 breach notification.** 365-day retention matches the `alerts` table window, sufficient to support incident investigation and — where applicable — the ODPC notification obligation up to a full year post-event.
- **Integrity through immutability.** No production code path performs `UPDATE` or `DELETE` on `audit_log` rows; RLS is configured deny-all against non-service-role identities. Writes only flow through the shared `auditLog()` helper authenticated with the `SERVICE_ROLE_KEY`.

**Scope of the audit trail:** every state-transition-worthy action in six lifecycle EFs. Non-scope: purely-informational polling events (e.g. `verify-payment` reading a still-pending Paystack status without changing anything), read operations, and events already exhaustively covered by `booking_status_history` (which is the source of truth for status transitions specifically).

---

## 2 — Configuration inventory

### 2.1 Table schema

```
Table: public.audit_log
Columns:
  id           uuid       PRIMARY KEY  DEFAULT gen_random_uuid()
  actor_type   text       NOT NULL
  actor_id     text       NULL
  action_type  text       NOT NULL
  target_type  text       NOT NULL
  target_id    text       NOT NULL
  payload      jsonb      NOT NULL     DEFAULT '{}'::jsonb
  created_at   timestamptz NOT NULL    DEFAULT now()
```

Notes on column semantics:

- `actor_type` — text, not enum. Currently only `'system'` is used in production. (See §5, backlog item on adding `'ops'` and `'customer'` actor_types as a future refactor.)
- `actor_id` — for Edge-Function-written rows, matches the EF file name (e.g. `'verify-payment'`, `'send-confirmation'`). For manual-ops rows, uses the convention `manual-ops-<initials>` (e.g. `'manual-ops-bev'`) to unambiguously distinguish from EF writes.
- `action_type` — describes the action taken. Current registered values are enumerated in §2.3 below.
- `target_type` / `target_id` — the entity acted upon. Typically `('pending_booking', <uuid>)` or `('booking', <uuid>)`. `target_id` is text (not uuid) to accommodate non-UUID identifiers if ever needed.
- `payload` — jsonb; identifiers-only per payload discipline (see §2.5).
- `created_at` — automatic timestamp.

### 2.2 Indexes

```
audit_log_target_idx   ON audit_log (target_type, target_id, created_at DESC)
audit_log_actor_idx    ON audit_log (actor_type, actor_id, created_at DESC)
audit_log_action_idx   ON audit_log (action_type, created_at DESC)
audit_log_pkey         ON audit_log (id)                                       — auto (PK)
```

Query patterns each index optimizes:

- `audit_log_target_idx` — "what happened to this booking?" (per-target lifecycle reconstruction).
- `audit_log_actor_idx` — "what did this EF do lately?" or "what did the ops operator do?" (per-actor audit trail).
- `audit_log_action_idx` — "how many payment_captured events fired today?" (per-action-type rate analysis).

### 2.3 Registered action_types (by writing Edge Function)

- **`initialize-payment`** — `payment_initialized`
- **`paystack-webhook`** — `payment_captured`, chargeback lifecycle types (`chargeback_opened`, `chargeback_reminder`, `chargeback_resolved_won`, `chargeback_resolved_lost`), refund lifecycle types (`refund_processed`, `refund_failed`)
- **`process-duffel-booking`** — `booking_created`, `duffel_order_failed`, `race_lost_no_booking` (per Session 40.b defensive classification)
- **`verify-payment`** — `payment_verification_failed`
- **`send-confirmation`** — `confirmation_email_sent`, `confirmation_email_failed`
- **`retry-stuck-bookings`** — reconciler-driven action_types (code shipped Session 40; cron paused since 2026-09-13 pending Session 49 reconciler rewrite + unpause)
- **Manual ops (`manual-ops-<initials>`)** — `refund_manual` (registered Session 41 for Paystack-dashboard-driven refunds when automated pipeline is unavailable). Additional `<verb>_manual` action_types to be registered per intervention class as needed.

### 2.4 Row-Level Security posture

```
Table RLS: ENABLED
Policies: (none)
```

The zero-policy posture means:

- `anon` role: no access (RLS enabled + no permissive policy = deny).
- `authenticated` role: no access (same).
- `service_role`: bypasses RLS by design; all writes flow through this role.

Access is exclusively via Edge Functions holding `SERVICE_ROLE_KEY`. There is no per-user access surface because `audit_log` is not a customer-facing data structure — it is a backend forensic tool.

This posture is deliberately distinct from the `auth.uid()`-scoped RLS posture on customer-facing tables (`profiles`, `saved_travelers`, `bookings`, `pending_bookings`, `booking_status_history`). Both postures are legitimate under DPA §41; each fits the access surface of its table.

### 2.5 Payload discipline (SOP §10, post-S40 renumber)

Every row's `payload` must:

- Contain only identifiers, status codes, and structured event context (amounts, currencies, correlation IDs).
- Never contain cleartext PII: no customer email, no phone number, no passenger name, no passport data, no date of birth.
- For payloads referencing a booking, prefer `merchant_ref` (the `TF-...` identifier), `paystack_tx_id`, `duffel_order_id`, or `pending_booking_id` — all of which are identifiers, not personal data.

Enforcement is by convention at the call site + code review; there is no runtime blocklist scrub on writes. This differs from the `alerts` email path (which does have a blocklist scrub via the two-path redaction architecture at `docs/security/alerts_redaction.md`) because `audit_log` is service-role-only and never leaves the DB boundary; PII in the audit trail would not leak to any downstream surface, but the discipline prevents it entering the log in the first place as a defense-in-depth measure.

### 2.6 Shared helper

`_shared/duffel-helpers.ts` exports `auditLog({ actor_id, actor_type, action_type, target_type, target_id, payload })`.

Every writing EF imports this helper. The helper handles the `SERVICE_ROLE_KEY`-authenticated call to the `audit-log` Edge Function endpoint (or writes directly to the table via the service-role Supabase client, depending on the current implementation). Migration to this shared helper is Session 40's "Option C decision" — see Session 40→41 handoff §1 for the reasoning behind consolidating on the shared helper rather than inlining audit calls per EF.

Local wrappers around `auditLog` are prohibited per RUNBOOK §17 (Shared helpers are the SINGLE source of truth, added Session 41.b).

### 2.7 Retention

365 days from `created_at`, enforced by a scheduled `pg_cron` job. See §8 of Framework Doc for the retention basis. The retention window matches the `alerts` table for the same DPA §43-supporting reason: incident investigation up to 12 months post-event should be able to reconstruct booking lifecycles.

---

## 3 — Verification procedure

### 3.1 Schema verification

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'audit_log'
ORDER BY ordinal_position;
```

Expected: 8 rows matching §2.1.

### 3.2 Index verification

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'audit_log'
ORDER BY indexname;
```

Expected: 4 rows (`audit_log_action_idx`, `audit_log_actor_idx`, `audit_log_pkey`, `audit_log_target_idx`).

### 3.3 RLS verification

```sql
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = 'audit_log' AND relkind = 'r';
```

Expected: one row, `relrowsecurity = true`.

```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE tablename = 'audit_log';
```

Expected: zero rows (deny-all posture confirmed).

### 3.4 End-to-end lifecycle verification (real successful booking)

For any successful booking merchant_ref `TF-<...>`, the following query surfaces the full lifecycle:

```sql
SELECT
  action_type,
  actor_id,
  target_id,
  payload,
  created_at
FROM audit_log
WHERE target_type = 'pending_booking'
  AND target_id IN (
    SELECT id::text
    FROM pending_bookings
    WHERE merchant_ref = 'TF-<paste merchant ref here>'
  )
ORDER BY created_at;
```

Expected shape for a successful booking (4 rows in order):

1. `initialize-payment` → `payment_initialized`
2. `paystack-webhook` → `payment_captured`
3. `process-duffel-booking` → `booking_created`
4. `send-confirmation` → `confirmation_email_sent`

Reference Session 41 test booking (2026-09-16): merchant_ref `TF-1789585987...` produced exactly this 4-row trace.

### 3.5 Payload discipline spot check

Random-sample recent payloads and verify no cleartext PII:

```sql
SELECT id, action_type, actor_id, payload
FROM audit_log
ORDER BY created_at DESC
LIMIT 20;
```

Manual review: every `payload` field should contain only identifiers and status codes. Any customer email, phone, name, DOB, or passport number in a payload is a discipline violation and warrants investigation (grep the writing EF's source to locate + patch the offending audit call).

---

## 4 — Rollback procedure

Removal of `audit_log` should never be necessary in normal operation. If required (e.g. for a hypothetical schema-migration incident), the procedure is:

### 4.1 Disable writes without dropping the table

```sql
REVOKE ALL ON public.audit_log FROM service_role;
```

This blocks the shared `auditLog()` helper's inserts without dropping accumulated forensic data. All writing EFs will receive permission errors on their audit calls; the `.catch` handlers in each writing EF prevent this from breaking the EF's primary function.

Re-enable:

```sql
GRANT INSERT, SELECT ON public.audit_log TO service_role;
```

### 4.2 Drop the table

```sql
BEGIN;
DROP TABLE IF EXISTS public.audit_log CASCADE;
COMMIT;
```

**Warning:** this is destructive. Verify before running: (a) no active forensic investigation depends on the accumulated rows, (b) 365-day retention hasn't been fingerprinted in any downstream doc that would become stale, (c) the Framework Doc §5 audit_log paragraph is updated in parallel.

### 4.3 Re-create

The original creation migration is `session_s40_audit_log_foundation.sql` (Session 40). Re-running it will restore the table + indexes + RLS state. Every EF's `auditLog()` calls resume writing without any code change (they're fire-and-forget with `.catch`).

---

## 5 — Backlog and known limitations

### 5.1 actor_type is currently only 'system' by convention

The schema defines `actor_type` as `text` (not enum), and the intent from the original Ops-1 spec was to use one of `'system' | 'ops' | 'customer'`. In production, every row uses `'system'`, including manual-ops writes (which use `actor_type = 'system'` + `actor_id = 'manual-ops-<initials>'` to disambiguate).

A future refactor could split `actor_type` into three distinct values:

- `'system'` — EF-written rows.
- `'ops'` — manual-operator-written rows (replacing the current `'system'` + `'manual-ops-<initials>'` two-field convention with a single `actor_type` distinction).
- `'customer'` — customer-initiated rows (e.g. self-service refund requests, saved-traveler edits — not currently audited).

The refactor is not required today because the `actor_id` prefix `'manual-ops-'` provides unambiguous filtering (`WHERE actor_id LIKE 'manual-ops-%'` cleanly surfaces every manual intervention). It would be worth doing:

- When customer-initiated audit rows are added (which would introduce a genuine third category).
- When a second manual-ops actor identity is regularly writing rows (which would create pressure for `actor_type = 'ops'` to be the primary filter rather than `LIKE 'manual-ops-%'`).
- As part of a larger audit_log v2 revision (e.g. when adding new columns or changing the row shape).

Until then, the single-actor_type-plus-convention approach is fully functional and does not compromise any DPA §41 claim.

### 5.2 No structured schema on `payload`

The `payload` column is `jsonb DEFAULT '{}'`. There is no per-action-type schema constraint on what fields must be present. This is deliberate — the payload is intended as a flexible identifier + context bucket — but it means a forensic query for "every row with a merchant_ref" must use `payload->>'merchant_ref'` and accept that some rows may not have that field.

Mitigation: RUNBOOK §14 (post S40-renumber) and this attestation document identify the payload fields typical for each action_type. Future evolution could add a payload schema catalog to Playbook §46b if payload heterogeneity becomes a forensic-query pain point.

### 5.3 Reconciler action_types pending Session 49

`retry-stuck-bookings` has audit_log calls in its source (shipped Session 40) but the cron is unscheduled since 2026-09-13 (see RUNBOOK §15). No `retry-stuck-bookings` rows have appeared in production since the pause. Once Session 49 unpauses the cron (following the Duffel-webhook redesign in Sessions 47-48), the reconciler's action_types will start appearing. Register them in Playbook §46b at that time.

### 5.4 Table growth + retention automation

At current pre-launch traffic, `audit_log` is small. Post-launch, growth is bounded by the transaction volume × ~4-5 rows per completed booking + additional rows for chargebacks, refunds, and ops interventions. At the customer-count scale envisaged for the first 12 months, this remains manageable.

The 365-day retention deletion job is scheduled but its exercise has not been observed in production (no rows are 365 days old yet — the table is younger than that). First rows will age out approximately 2027-09-08 (365 days after Session 40's foundation ship). Verify the deletion runs at that time; if it doesn't, investigate the cron job's scheduling.

### 5.5 No `audit_log` UI surface

Reads are SQL-editor-only for now. The Ops dashboard buildout (Ops-4 per Master Playbook §46 workstream) will introduce a per-booking timeline panel that unions `audit_log` + `booking_status_history` for the currently-viewed booking. Ops-4 hasn't shipped; it's post-launch. Until Ops-4 ships, forensic queries are executed by the DPO directly against the DB.

---

## 6 — Change management reference

**Foundation ship:** Session 40 (2026-09-08 to 2026-09-14). Composite commit `013e4e1` on origin/main.

Migration files:

- `session_s40_audit_log_foundation.sql` — table + 3 indexes + RLS enable.

Edge Function retrofits:

- Session 40: `initialize-payment`, `paystack-webhook`, `process-duffel-booking`, `retry-stuck-bookings` (code, cron paused).
- Session 41 (2026-09-16): `send-confirmation` (commit `eb69416`), `process-duffel-booking` widening for correlation (commit `9205870`), `verify-payment` (Session 41 late add — see verify-payment retrofit patch spec).

Shared helper:

- `_shared/duffel-helpers.ts` — `auditLog()` export added Session 40 as "Option C decision." Local wrappers prohibited per RUNBOOK §17 (Session 41.b).

Related SOP sections:

- SOP §10 (post-S40 renumber) — audit_log payload discipline (no cleartext PII).
- SOP §13 (Session 41) — audit_log manual-ops actor convention.

Related RUNBOOK sections:

- §14 (post-S40 renumber) — audit_log ops, action_type catalog, verification queries.
- §14.a (Session 41) — Retrofit payload-correlation discipline (the `pending.id` widening lesson from the `send-confirmation` retrofit).
- §17 (Session 41.b) — Shared helpers rule.
- §19 (Session 41) — Webhook shared-secret rotation (referenced from §14 as the class-of-issue that motivates recording `refund_manual` rows for ops-initiated interventions).

Related Playbook sections:

- §46b (post-S40 renumber) — audit_log action_type catalog.

Related legal documents:

- Framework Doc v1.1 revised §5 (Alerting and audit) — the outward-facing DPA §41 description.
- Framework Doc v1.1 revised Appendix C — attestation index (this file's entry).
- KYC Fraud Prevention v1.3 §2 — the outward-facing supplier-KYC description.

---

## 7 — Deployment record

| Date | Session | Change | Verified |
|---|---|---|---|
| 2026-09-08 | S40 | Foundation migration + 4 EF retrofits (initialize-payment, paystack-webhook, process-duffel-booking, retry-stuck-bookings) | End-to-end synthetic test produced 3-row lifecycle. |
| 2026-09-16 (a.m.) | S41 | send-confirmation retrofit — `confirmation_email_sent`, `confirmation_email_failed` action_types | Deploy `eb69416`. Awaited process-duffel-booking widening for correlation. |
| 2026-09-16 (a.m.) | S41 | process-duffel-booking widening — request body extended with `pending.id` + `merchant_ref` for send-confirmation audit correlation | Deploy `9205870`. Real successful booking produced 4-row lifecycle trace verified against production `audit_log`. |
| 2026-09-16 (evening) | S41 | Manual-ops audit rows for two stuck-booking refunds (webhook-secret rotation incident) | `refund_manual` action_type, `actor_id = 'manual-ops-bev'`. Written via SQL editor in BEGIN/COMMIT block with pre-commit verification SELECT. |
| 2026-09-16 (late) | S41 | verify-payment retrofit — `payment_verification_failed` action_type on atomic Paystack-terminal-failed transition | Deployed via `supabase functions deploy verify-payment`. Grep confirms `auditLog` import + call site. First live trigger awaits real customer failed-payment event. |

---

*End of `audit_log_attestation.md`. Prepared Session 41 (2026-09-16). Owner: DPO; post-hire, transitions to Ops / security engineering per §14 of `TumaFly_Handoff_Security_Audit_Remediation.md`.*
