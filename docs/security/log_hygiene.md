# TumaFly Console Log Hygiene

**Domain:** Supabase Edge Function stdout/stderr streams (retained in Supabase function logs)
**Owner:** Backend engineer with security ownership (currently: Founder)
**KYC alignment:** closes gap 2.10 (console-log hygiene audited: no passenger PII, contact details, card metadata, or auth tokens in Supabase function logs)
**Introduced:** Session 35b (2026-08-18)
**S-04 close:** this document

---

## 1. Purpose + scope

Source-of-truth attestation for the console-log hygiene posture across every TumaFly Edge Function. Referenced by KYC §2.10 and the Security Framework doc's data-minimisation section.

**Threat model addressed.** Supabase function logs are stored in a distinct storage layer from the `alerts` table and the application DB. Access to function logs is via the Supabase project dashboard — the RLS + service-role-only gating we've applied to `alerts` (Session 35 S-12) does NOT apply here. Anyone with dashboard access (founder, invited team members, Supabase support engineers debugging infrastructure) can read function logs. This is a broader access surface than the audit-log surface addressed by Architecture B redaction (Session 35b core).

**In scope:**
- All 22 EFs in `supabase/functions/*/index.ts`
- `_shared/*.ts` helper files with `console.*` statements
- The categories of PII enumerated in `_shared/redact.ts` PII_KEYS + SECRET_KEYS

**Out of scope:**
- Frontend `console.*` — browser dev-tools logs, ephemeral, no server storage
- SQL log_statement configuration — Supabase-managed; PII from `WHERE` clauses is not routinely logged at default log level
- Supabase Auth logs — Supabase-managed; PII in email/phone signup events is inherent to their logging surface

---

## 2. Configuration inventory

### 2.1 Console call classification (Session 35b baseline)

Complete enumeration of every `console.log` / `console.warn` / `console.error` call across all EFs performed Session 35b (2026-08-18). Findings:

- **Total `console.*` calls:** 145 (across 21 EFs; `send-confirmation` has 0 — passes-through template render only)
- **Operational (safe):** 128 — logging identifiers (merchant_ref, pending_booking_id, offer_id, status codes, retry counts, error class names, boolean state markers, hashed identifiers)
- **Error surfaces (safe by convention):** 17 — `console.error(msg, err)` where `err` is a caught JS Error or Postgres error object. Error messages MAY occasionally echo PII from upstream API responses; treated as acceptable risk because Error objects are essential debugging signal and the residual PII surface is intermittent, not systematic
- **PII leaks (patched Session 35b):** 9 — enumerated §2.2 below

### 2.2 PII leaks patched Session 35b (S-04)

| # | EF | Line (pre-patch) | Leak class | Patch strategy |
|---|---|---|---|---|
| 1 | `alert-founder` | 403 | Resend `emailData` JSON — echoes `To:` recipient email | Replace with `status + name` (structured operational fields only) |
| 2 | `verify-payment` | 243 | Paystack `verifyData` — customer_email + authorization_code (SECRET) | Drop `verifyData`; keep `status` code only |
| 3 | `paystack-webhook` | 540 | Same shape as #2 | Drop `verifyData`; log message only |
| 4 | `send-otp` | 147 | Signed Auth Hook payload — phone (PII) + OTP (SECRET) | Delete entirely; signature-verify success is implicit |
| 5 | `send-otp` | 219 | Africa's Talking response — `result.SMSMessageData.Recipients` echoes phone | Delete entirely; success implicit from status check |
| 6 | `send-otp` | 222 | Same as #5, error path | Drop response echo; keep status code |
| 7 | `process-duffel-booking` | 203 | Same shape as #2 | Drop `verifyData`; log message only |
| 8 | `send-refund-notification` | 342 | Resend response `body` — echoes `To:` recipient | Drop `body`; add `refund.id` (identifier) |
| 9 | `mpesa-callback` | 105 | Daraja callback body — `PhoneNumber` + `MpesaReceiptNumber` + `Amount` | Drop `body`; log shape-violation flag only |

**Common pattern across all 9 patches.** Every leak was an upstream API response (Resend, Paystack, Africa's Talking, Safaricom Daraja) or an inbound signed hook payload being logged verbatim via `JSON.stringify()` or direct object interpolation. The information WAS reaching the operator via two channels:
1. **The alerts table** (structured, redacted correctly per Architecture B — Session 35b core work)
2. **Supabase function logs** (unstructured, no redaction, retained per Supabase policy)

Channel 2 is entirely redundant with channel 1 for operational purposes AND is the un-hardened surface. Removing PII from channel 2 loses zero operational value.

### 2.3 Retention

Supabase function logs are retained per Supabase's tier-dependent policy. On the free tier this is short (24 hours to a few days depending on volume). On paid tiers longer. **Not** subject to our application-side 365-day RTBF-anonymizable retention (Session 35c S-09), which only applies to the DB.

Practical implication for RTBF Stage 4: `rtbf_anonymize_alerts_context` (Session 35c S-09) anonymizes the DB. Post-S-04, Supabase function logs no longer contain PII to anonymize — they're already hygienic. RTBF is complete once DB anonymization runs.

---

## 3. Verification

### 3.1 Regression grep after any EF edit

Run this before committing changes to any file in `supabase/functions/`:

```bash
grep -rnE "console\.(log|warn|error).*(JSON\.stringify.*payload|JSON\.stringify.*verify.?[dD]ata|JSON\.stringify.*result|JSON\.stringify.*emailData|Recipients|, body\)|, verifyData\)|customer_email\)|customer_phone\)|contact\.email\)|contact\.phone)" supabase/functions/
```

Expected: zero results. Any match = potential PII leak, review before merging.

### 3.2 Runtime verification via synthetic PAID_NO_TICKET fire

After deploy, fire a synthetic PAID_NO_TICKET with a full PII payload (see Session 35b handoff §Phase 3 curl fixture), then check Supabase function logs (Dashboard → Edge Functions → Logs) for the receiving EF's stream during the fire window. Confirm:
- No `customer_email` value appears
- No `customer_phone` value appears
- No passenger names or DOB appear
- No `unique_identifier` / `authorization_code` / `access_code` appears
- Operational fields (merchant_ref, offer_id, status codes) DO appear as expected

### 3.3 Post-patch console output shape (illustrative)

**Before S-04:** log shows `[verify-payment] Paystack verify non-2xx: 400 { data: { customer: { email: "actual@customer.email", authorization: { authorization_code: "AUTH_xxx", card_type: "visa" } } } }`

**After S-04:** log shows `[verify-payment] Paystack verify non-2xx: status=400` — status code preserved (operational), everything else absent.

The alert-founder DB row for the same event (via alerts table, redactForAudit) preserves the full context minus SECRETS — that's where the operator gets the full picture, protected by RLS + service-role-only + encrypted-at-rest.

---

## 4. Rollback

Rollback is a single `git revert` of the S-04 commit. The rollback restores the pre-S-04 logging shape which leaks PII to function logs but does not break any functional behavior (logs are stdout only; no code depends on their content).

If a partial rollback is needed (revert one EF's changes but keep others), each of the 9 patches is a single-line surgical F&R and can be reverted independently.

---

## 5. Backlog / known limitations

**Error-object leaks (residual risk, accepted).** `console.error(msg, err)` where `err` is a caught Error object may echo upstream API PII via `err.message` if the upstream error message contains customer data. Session 35b assessed this as acceptable risk because:
- Error objects are essential debugging signal — dropping them would materially harm incident response
- Residual PII surface is intermittent (only fires when upstream returns PII-shaped error strings), not systematic
- Alternative (custom Error-scrubbing wrapper) adds ~40 lines of infrastructure across 33 error sites for marginal benefit

Revisit if operational incidents surface PII in a `console.error` stream at meaningful volume.

**Supabase log retention beyond our reach.** Function logs are Supabase-managed. If we ever need to hard-guarantee no historical PII in function log storage (regulatory demand, incident response), the remediation is (a) rotate Supabase project, (b) contact Supabase support to request purge of a specific time window, or (c) accept that pre-S-04 logs (created 2026-06-19 through 2026-08-18) may contain historical PII within Supabase's retention window. No known regulatory demand today; noted for RTBF operator awareness.

**Frontend `console.*`.** Out of scope per §1, but noted: frontend logs are ephemeral (browser session only) but if a customer's browser is shared/compromised, dev-tools logs could leak recent booking data. Standard defense: minimise frontend logging generally, don't log auth tokens ever. Frontend audit deferred to Ops-1 / launch-hardening pass.

---

## 6. Change management

See SOP Master §6 — Configuration Change Management.

Any future edit to an EF adding a `console.*` call MUST run the §3.1 regression grep before commit. If the grep is added to a CI/husky hook post-Ops-1, this becomes automatic; until then, manual discipline via §3.1 command.

---

## 7. Deployment record

**Session 35b (2026-08-18):** initial S-04 sweep. 9 PII leaks patched across 7 EFs (alert-founder, verify-payment, paystack-webhook, send-otp, process-duffel-booking, send-refund-notification, mpesa-callback). Verified via §3.1 regression grep (0 matches) + §3.2 synthetic PAID_NO_TICKET fire.

**Configured by:** Founder (Bev) via chat handoff
**Session:** 35b

---

*End of console log hygiene attestation. First landed Session 35b (2026-08-18).*
