# S-14b/c Encrypted-View Window Probe

**Status:** Investigation plan drafted Session 49.a (2026-10-16); execution in Session 50.
**Owner:** Session 50 pre-launch data hygiene scope.
**Blocking:** Not a launch blocker, but the findings may surface a latent bug that would block Session 54 GO/NO-GO.

---

## Why this probe exists

On 2026-10-15, under SOP §13 manual-ops, we cleaned a 59-row backlog of `pending_bookings` rows stuck at `status='booked' AND confirmation_email_sent_at IS NULL` — customers whose Duffel booking succeeded but who never received their confirmation email.

Tracing the 59 rows by `created_at` surfaced a startling pattern: **55 of 59 (93%) were created during the four-day window 2026-09-06 → 2026-09-10.** The remaining 4 rows are scattered across other dates.

That window is specifically the first four days after the S-14b/c encrypted-view migration shipped (commit `5fbbbb4`, 2026-09-06). S-14b/c moved several EFs — including `send-confirmation` — to read from `pending_bookings_decrypted` instead of `pending_bookings`.

**What we previously assumed:** Session 40.b Resend-overwhelm was the primary cause of the backlog. That turns out to be ~5% of the backlog (3/59), not 93%.

**What this probe needs to establish:** whether there's a latent bug in `send-confirmation` (or an adjacent EF) that fires only under some condition we haven't fully characterised, and whether that bug is still live post-Session-45 — or whether something later in the Session 40.b–48 sequence quietly resolved it.

Either answer feeds Session 50 scope:
- **Bug still live** → Session 50 fixes it before Session 54 launch.
- **Bug no longer live** → Session 50 records the resolution, moves on.
- **Can't tell from the probe alone** → Session 50 adds instrumentation (alert, log line, metric) that will catch it on first fire post-launch.

---

## Hypotheses

Ordered by prior likelihood from the Session 49.a review of the migration + file history.

### H1 — `send-confirmation` reads the un-decrypted view post-migration

**Shape:** S-14b/c migration moved `pending_bookings` writes to a trigger-based encryption pattern. The `pending_bookings_decrypted` view returns plaintext for reads. If `send-confirmation` was not updated to read the view, it would get encrypted ciphertext for `contact.email`, `passengers`, etc., and either (a) send email to a ciphertext string (Resend rejects, delivery fails, our EF logs error, we don't stamp `confirmation_email_sent_at`) or (b) crash before the Resend call.

**Testable with:** code read of `send-confirmation/index.ts` + diff against pre-migration version. Look for `pending_bookings_decrypted` references.

**Why this is H1:** matches the exact window symptom. The migration shipped 2026-09-06; the stuck rows start 2026-09-06. If `send-confirmation` was patched between 2026-09-10 and now, the pattern would stop at 2026-09-10 (which it does).

### H2 — Resend bounces on ciphertext-shaped email addresses, no stamp

**Shape:** same as H1 but downstream. Even if the EF code successfully makes the Resend API call, the `to:` field being ciphertext would mean Resend bounces the recipient. If `send-confirmation` only stamps `confirmation_email_sent_at` on 2xx from Resend, the stamp never happens, the Bucket 6 bucket collects the row, and the historical no-dedup-storm Session 40.b self-DoS pattern applies.

**Testable with:** Resend delivery logs for 2026-09-06 → 2026-09-10, cross-referenced with the 55 stuck rows' email addresses.

### H3 — `send-confirmation` was patched quickly but the 55 rows were orphaned

**Shape:** a patch landed 2026-09-10 (or earlier) that fixed the read path, but it didn't retroactively process the stuck rows. The 55 rows just sat there because retry-stuck-bookings was already paused by that point (Session 40.b unschedule was 2026-09-13 — three days after the window closes; depending on exact timing, the cron may have been firing on those rows and timing out, OR not firing at all).

**Testable with:** `git log --oneline --since="2026-09-06" --until="2026-09-20" -- supabase/functions/send-confirmation/` + commit inspection.

### H4 — Something else entirely

If H1–H3 don't match the evidence, there's a less obvious cause. The probe plan ends with "escalate to Session 50 scope expansion" rather than guessing.

---

## Probe plan — SQL queries

Run against prod Supabase SQL editor (red [PROD] tab per RUNBOOK §26.4a). All queries are read-only.

### Query 1 — confirm the window shape

Confirms the 55-of-59 split is real and reproducible, not an artefact of the SOP §13 cleanup query.

```sql
SELECT
  date_trunc('day', created_at)::date AS created_day,
  COUNT(*) AS row_count
FROM pending_bookings
WHERE status IN ('booked', 'confirmed')  -- include confirmed in case SOP §13 moved any
  AND confirmation_email_sent_at IS NULL
  AND created_at >= '2026-09-01'::date
  AND created_at < '2026-10-01'::date
GROUP BY 1
ORDER BY 1;
```

**Expected shape if H1 holds:** heavy concentration on 2026-09-06 through 2026-09-10, near-zero before 2026-09-06 and after 2026-09-10. Even distribution would refute H1.

### Query 2 — alert history for the window

Shows which alerts fired during the window, and whether `CONFIRMATION_EMAIL_FAILED` was among them. If H1 is true, we'd expect to see many `CONFIRMATION_EMAIL_FAILED` fires during the window.

```sql
SELECT
  date_trunc('day', created_at)::date AS day,
  alert_type,
  COUNT(*) AS fires,
  COUNT(*) FILTER (WHERE suppressed = false) AS delivered
FROM alerts
WHERE created_at >= '2026-09-06'::date
  AND created_at < '2026-09-15'::date
GROUP BY 1, 2
ORDER BY 1, 2;
```

**What to look for:**
- `CONFIRMATION_EMAIL_FAILED` fires during 2026-09-06 → 2026-09-10 → consistent with H1 or H2.
- Zero `CONFIRMATION_EMAIL_FAILED` fires but `UNHANDLED_ERROR` from `send-confirmation` → consistent with H1 crash variant.
- Zero EF alerts of either type → suggests the EF never got to a logging path, consistent with H1 silent crash OR H3 (the cron wasn't firing on these rows for some reason).

### Query 3 — individual row inspection

Pull a sample row from the window and reconstruct its full history. Note: these are prod rows for real customers; treat the output as PII and don't paste into chat verbatim. Compare the fields visible in `pending_bookings_decrypted` against what the EF code would receive.

```sql
-- Pick one row from the window as a representative sample
SELECT
  pb.id,
  pb.merchant_ref,
  pb.status,
  pb.created_at,
  pb.updated_at,
  pb.confirmation_email_sent_at,
  pb.duffel_order_id,
  pbd.contact->>'email' AS decrypted_email,
  LENGTH(pb.contact::text) AS raw_contact_length,
  LENGTH(pbd.contact::text) AS decrypted_contact_length
FROM pending_bookings pb
LEFT JOIN pending_bookings_decrypted pbd ON pbd.id = pb.id
WHERE pb.status IN ('booked', 'confirmed')
  AND pb.confirmation_email_sent_at IS NULL
  AND pb.created_at >= '2026-09-06'::date
  AND pb.created_at < '2026-09-11'::date
ORDER BY pb.created_at
LIMIT 1;
```

**What to look for:**
- `raw_contact_length` vastly different from `decrypted_contact_length` → confirms the ciphertext/plaintext distinction is meaningful.
- `decrypted_email` is a readable email address → confirms the decrypted view works for this row.
- Compare against a row from the same window after the cleanup — if the cleanup rows look identical in shape, the latent bug was never in the data, it was in which view the EF read from.

### Query 4 — booking_status_history for the sample row

If `booking_status_history` was populated during that window (verify first — it may not have been), it reveals the exact transition sequence for the stuck rows.

```sql
-- Replace <SAMPLE_ROW_ID> with the id from Query 3
SELECT
  changed_at,
  from_status,
  to_status,
  changed_by,
  payload
FROM booking_status_history
WHERE pending_booking_id = '<SAMPLE_ROW_ID>'
ORDER BY changed_at;
```

**What to look for:**
- Transition from `booked` to any further state (or lack thereof) — a stall at `booked` with no further transitions is the signature of "send-confirmation never ran or never completed."
- `changed_by = 'send-confirmation'` entries → means the EF reached the stamp code path at least once; absence means it never did.

### Query 5 — `audit_log` for the sample row

`audit_log` was foundationed in Session 40 (shipped 2026-09-08 — mid-window). Rows created on or after 2026-09-08 should have audit entries if any EF touched them; rows before that date won't.

```sql
-- Replace <SAMPLE_ROW_ID> with the id from Query 3
SELECT
  created_at,
  actor_type,
  actor_id,
  action_type,
  target_type,
  target_id,
  payload
FROM audit_log
WHERE target_id = '<SAMPLE_ROW_ID>'
   OR payload->>'pending_booking_id' = '<SAMPLE_ROW_ID>'
ORDER BY created_at;
```

**What to look for:**
- Any `action_type = 'confirmation_email_fired'` or similar → confirms send-confirmation ran at least once.
- Any `action_type = 'confirmation_email_failed'` or similar → confirms a failure code path was reached.
- Complete absence of send-confirmation-origin rows → consistent with H1 silent crash (never got to the audit call).

---

## Probe plan — code review

Independent of the SQL queries. Can be done in Session 49.a if time; otherwise Session 50 opens with it.

### Step A — git log the window

```bash
cd ~/tumafly-backend
git log --oneline --since="2026-09-01" --until="2026-09-20" -- \
  supabase/functions/send-confirmation/ \
  supabase/functions/_shared/
```

List every commit touching `send-confirmation` or `_shared` during and immediately after the window.

### Step B — read send-confirmation at the window's start

```bash
# Find a commit from 2026-09-06 or just before
git log --oneline --before="2026-09-06" --until="2026-09-07" -- supabase/functions/send-confirmation/

# Then show the full file at that commit
git show <commit_sha>:supabase/functions/send-confirmation/index.ts
```

Check:
1. Does it `.from("pending_bookings")` or `.from("pending_bookings_decrypted")` for its reads?
2. Does it stamp `confirmation_email_sent_at` only on Resend 2xx, or always?
3. Does it log a failure before returning, so we'd see something in `audit_log` or Function Logs if a crash happened?

### Step C — read send-confirmation at the window's end

Same as Step B but for a commit on or around 2026-09-11. Diff against Step B's version:

```bash
git diff <step_b_commit>:supabase/functions/send-confirmation/index.ts \
         <step_c_commit>:supabase/functions/send-confirmation/index.ts
```

Any changes to the read path or the stamp path are the likely culprit.

### Step D — read send-confirmation at HEAD

```bash
cat supabase/functions/send-confirmation/index.ts | head -100
```

Confirm the current version is correct. If H1 is true but the bug was patched later, HEAD will match H3's expectation — correct read path, correct stamp path, 55 rows just orphaned by timing.

---

## Deliverables for Session 50

After executing the queries and code review, Session 50 produces a short investigation note at `docs/investigation/s14bc_findings_<date>.md` with:

1. **Confirmed cause** (one of H1/H2/H3/H4 or a combination).
2. **Is it still live post-Session-45?** (Yes/No/Can't tell.)
3. **Mitigation if still live** — specific EF patch, test to add, alert to register.
4. **Mitigation if not live** — the resolution path (which commit fixed it, when).
5. **Any new instrumentation to add pre-launch** — if the probe surfaces a class-of-issue broader than just send-confirmation, Session 50 may add a cross-EF read-path audit at the same time.

Carry findings forward to Session 54 GO/NO-GO: a "H1/H2 confirmed and not fully mitigated" state is a NO-GO signal.

---

## Operator cautions

1. **These are prod rows.** Query results contain customer PII. Do not paste into chat verbatim; redact emails and names before sharing SQL output outside the owner's local terminal.
2. **The 59 rows are already cleaned.** The window shape queries work against the current state (post-cleanup) because `confirmation_email_sent_at` has NOT been retroactively stamped on the cleaned rows — SOP §13 cleanup moves them past the Bucket 6 scan via the manual-ops path, but doesn't stamp them as if the email actually went out. If your query returns zero rows for the window, the cleanup DID stamp them and you'll need to join on an alternative signal (e.g. a specific audit_log entry pattern).
3. **Session 48's `duffel_webhook_events` table doesn't help here.** This probe is about `send-confirmation` (post-ticket), not `duffel-webhook` (pre-ticket). The event-stream reconciler Session 49.a shipped won't catch future instances of this bug — it's a complementary observation surface.
4. **If H3 is confirmed**, Session 49.b's cron resume is safe for this class of issue — the rows that were affected are already handled by SOP §13, and the 14-day date filter in Bucket 6 (Commit 4) prevents the re-sweep problem. But H3 doesn't mean the underlying read-path bug is fixed; a new occurrence tomorrow would re-create the backlog shape. Session 50 verifies which.

---

*End of probe plan. Session 50 opens with Query 1 and Step A.*