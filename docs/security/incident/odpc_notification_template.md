# ODPC Personal Data Breach Notification Template

**Location:** `docs/incident/odpc_notification_template.md`
**Purpose:** statutory notification to the Office of the Data Protection Commissioner (ODPC) of a personal data breach, per Kenya Data Protection Act 2019 §43, within 72 hours of TumaFly becoming aware.
**Version:** v0.2 (revised for Session 35b close, 2026-08-19) — supersedes v0.1

---

## Ownership + execution

| Role | Responsibility |
|---|---|
| **Draft author** | Ops/Support (Tier 1) — per Session 35d Ops/Support hiring brief §5 (RTBF/compliance ownership) + §50 (preparing ODPC filings under engineer/founder review) |
| **Technical + fact reviewer** | Engineer (Tier 2) — per Session 33 security role hiring brief (incident response ownership) |
| **Legal reviewer** | James (advocate) — statutory language + defensibility |
| **Brand + strategic sign-off** | Founder — final gate before send |
| **Send authority** | Founder — cannot delegate statutory filing (data controller responsibility) |
| **Send channel** | ODPC portal at odpc.go.ke (founder-authenticated login); portal is the filing surface — no from-address applies |
| **Template maintainer** | James (advocate) — legal template updates on DPA amendments, ODPC guidance changes |
| **Template review triggers** | DPA amendments, ODPC guidance updates, ODPC portal migrations, post-incident findings surfacing template gaps, quarterly review |

**Pre-Ops-1 (current state):** founder holds every role except James. Founder drafts + reviews + sends. James remains external legal reviewer regardless of team size.

**Referenced from:** SOP §4.2 (Data breach protocol) + SOP §4.6 (Notification obligations); companion templates: `customer_breach_notification_template.md`, `internal_incident_report_template.md`; role definitions: Session 33 security role hiring brief + Session 35d Ops/Support hiring brief §5, §50, §70.

---

## When to file

**Trigger:** any of the following, once confirmed to affect personal data:
- Unauthorized access to production databases (Supabase / auth store)
- Credential compromise where the credential grants access to personal data (SERVICE_ROLE_KEY, DUFFEL_WRITE_KEY, Paystack secret key, etc.)
- Confirmed data exfiltration from any system storing personal data
- Loss of a physical device containing personal data (laptop, backup drive)
- Third-party processor breach affecting our customers (Duffel, Paystack, Resend, Supabase-side, Cloudflare-side) — even where we're not the primary breached party, our attestation obligation to ODPC per §43 still applies for our data subjects

**Do NOT file for:**
- Failed unauthorized access attempts (attackers tried and failed — this is expected background)
- Alert firing without confirmed breach (e.g. GUEST_TOKEN_ATTEMPT_THRESHOLD alerts, WAF blocks)
- Internal errors that expose data only to authorized staff
- Publicly-available data being scraped

**When in doubt, file.** Ops flags candidates for engineer + founder + James assessment; the four-way check makes the call. Under-notification carries greater regulatory risk than over-notification.

## Timing

- **Awareness → notification: <72 hours** (statutory deadline per DPA §43(1))
- **Awareness** = the moment any TumaFly staff member confirms with reasonable certainty that a breach has occurred, NOT the moment of first suspicion. Documented in the incident timeline with named-actor + timestamp.
- If the full picture isn't known at 72h, file with what's known and update as investigation continues (§43(4) supports incremental filing)

## Recipient

**Primary:** The Data Commissioner
Office of the Data Protection Commissioner
Filing channel: ODPC portal at [verify at odpc.go.ke — check for portal URL updates before filing]
Postal fallback: [current ODPC address per their website]

**Copy for internal audit trail:** compliance@tumafly.com (auto-CC or manual after portal submission)

## Filing incident tracker convention

Incident ID: `TF-INC-YYYYMMDD-NN` (matches internal incident report + customer notification if applicable)

---

## Body template

Below is the template. Ops drafts, filling every **[BRACKETED]** item with facts confirmed as of send time. No speculation. If a fact is genuinely unknown at 72h, state that explicitly and note per §43(4) update commitment.

---

Dear Data Commissioner,

TumaFly Kenya Limited (ODPC registration [PENDING / registration number]), operating as data controller, submits the following notification pursuant to §43 of the Data Protection Act, 2019.

**Incident Reference:** [TF-INC-YYYYMMDD-NN]

**Timing:**
- TumaFly became aware of the incident at approximately [HH:MM EAT] on [DD Month YYYY].
- This notification is submitted at [HH:MM EAT] on [DD Month YYYY], within [Xh Ym] of awareness.
- Investigation status at time of filing: [initial / ongoing / substantially complete].

### 1. Nature of the breach

[Ops drafts factual description with engineer's technical accuracy review. Cover:
- What system(s) were affected
- How the breach was discovered (alert / customer report / third-party notification / internal audit)
- What personal data was accessed, altered, disclosed, or destroyed
- The timeline of the incident (first known compromise → discovery → containment)

Avoid: speculation on attacker identity or motive if not confirmed; assurances that cannot be verified; blame attribution to third parties without evidence.]

### 2. Categories and approximate number of data subjects concerned

**Data subject categories:**
- [e.g. "Registered TumaFly customers who made bookings between [date range]"]
- [e.g. "Guest bookers who used TumaFly without registering an account"]

**Approximate number:** [approximately N individuals]

**Basis for count:** [how you arrived at the number — DB query, log analysis. If uncertain, provide upper-bound estimate + basis for uncertainty. Engineer verifies query correctness.]

### 3. Categories and approximate number of personal data records concerned

**Categories of personal data affected:**
- [e.g. "Contact details: email addresses, phone numbers"]
- [e.g. "Travel document data: passport numbers, dates of birth, nationality — protected by pgcrypto column encryption at rest per docs/security/saved_travelers_encryption.md; state at time of access was [encrypted/decrypted]"]
- [e.g. "Booking history: routes flown, dates of travel"]
- [e.g. "Financial data — payment method identifiers only (last-4 digits, card brand). No full card numbers, CVVs, or bank credentials were stored by TumaFly; these are held by our payment processor Paystack (their systems were [affected/not affected])."]

**Special categories under §44 (if any):** [state explicitly — passport data is treated as sensitive under our security posture regardless of specific legal classification]

**Approximate number of records:** [approximately N records across all categories]

### 4. Likely consequences of the breach

[Ops drafts with engineer input on technical exposure. Cover honestly and specifically:
- Identity theft risk (passport number + DOB combined enables strong identity dossier)
- Fraudulent bookings using compromised traveler profiles
- Targeted phishing of affected customers
- Financial fraud attempts on affected payment methods
- Reputational harm to affected individuals

Be specific to the actual breach. Under-stating consequences is worse than over-stating; ODPC evaluates the reasoning.]

### 5. Measures taken or proposed to address the breach

**Immediate containment (completed by Engineer per SOP §4.4):**
- [Timestamp] [Action, e.g. "Rotated all Duffel API keys per SOP §1"]
- [Timestamp] [Action, e.g. "Disabled compromised edge function pending investigation"]
- [Timestamp] [Action, e.g. "Locked affected user accounts pending customer verification"]

**Ongoing remediation:**
- [Actions in progress with expected completion timing]
- [Data subject notification plan per §43(3), if applicable — see section 6]

**Long-term preventive measures:**
- [Specific to root cause — e.g. "Adding CI check for SERVICE_ROLE_KEY regression per RUNBOOK §SERVICE_ROLE_KEY discipline"]
- [e.g. "Accelerating pgcrypto key rotation to monthly for affected column categories"]
- [e.g. "Post-incident review scheduled for [date]; findings will be shared with ODPC upon request"]

### 6. Data subject notification per §43(3)

[Assess whether breach is likely to result in high risk to rights and freedoms of affected data subjects. If yes, §43(3) requires direct notification.

State the assessment:
"We assess this breach [does / does not] meet the high-risk threshold for §43(3) notification. Reasoning: [reasoning based on section 4 consequences assessment]. Accordingly, we [will / will not] issue direct notifications to affected data subjects."

If notifying:
"Notification will be delivered via [email from hello@tumafly.com / SMS via Africa's Talking / WhatsApp from +254 113 165 503] on or before [date, ideally within 7 days of this filing]. Notification content template attached as Annex A."]

### 7. Contact point

**Primary contact for follow-up:**
[Founder name] — Founder & Data Controller
Email: compliance@tumafly.com
Phone: +254 113 165 503
Postal: [company registered address]

**Data Protection Officer** [if designated]:
[DPO name / firm]
Email: [dpo email]

**Legal advocate:**
[James's name]
[Firm name]
Email: [email]
Phone: [phone]

We remain available to provide any further information the ODPC requires and will update this notification per §43(4) as investigation continues.

Sincerely,

[Founder name]
Founder & Data Controller
TumaFly Kenya Limited
[Company registration number]

---

## Attachments (optional, when relevant)

Include only if directly probative and PII-safe:

- **Annex A** — Data subject notification content (if §43(3) triggered)
- **Annex B** — Technical incident timeline with sanitized log excerpts (Engineer prepares; Ops sanitizes)
- **Annex C** — Affected data category detail (aggregate counts, no individual PII)

**Do NOT attach:**
- Raw log data containing PII
- Screenshots of customer records
- Internal Slack/email chains with candid speculation
- Legal advice from James (privileged)

---

## Operator checklist by role

### Ops/Support (drafter)
- [ ] Incident report (internal) drafted and reviewed with engineer before starting this ODPC draft
- [ ] All **[BRACKETED]** items filled with confirmed facts, not speculation
- [ ] Timing calculation verified: awareness → send is <72h
- [ ] ODPC portal URL verified (portal has moved before per SOP §4.6)
- [ ] Attachments sanitized of PII (if any)
- [ ] Draft placed in `docs/incident/drafts/TF-INC-YYYYMMDD-NN_odpc_draft.md`
- [ ] Draft routed to Engineer for fact review (24h max turnaround)
- [ ] Draft routed to James after Engineer sign-off (24h max)
- [ ] Draft routed to Founder after James sign-off (final review + send)

### Engineer (fact reviewer)
- [ ] Nature of breach (§1) is technically accurate — no misrepresentation of system state
- [ ] Categories + counts (§2, §3) match actual DB queries; queries documented for future audit
- [ ] Consequences (§4) reflect actual data sensitivity + exposure state
- [ ] Containment actions (§5) match SOP §4.4 execution + are truthfully documented
- [ ] Any specific KYC claim referenced is accurate against current shipped code (grep-verified)
- [ ] Sign-off written to draft file with timestamp before routing to James

### James (legal reviewer)
- [ ] §43(1) 72h deadline met or explicit reason for delay documented
- [ ] §43(2) content requirements all present (nature, subjects, records, consequences, measures, contact)
- [ ] Language defensible under Kenya DPA + General Regulations 2021
- [ ] No claims created without evidence that could create legal exposure
- [ ] §43(3) high-risk assessment reasoning is defensible
- [ ] Contact points valid + reachable
- [ ] Sign-off written with timestamp before routing to Founder

### Founder (send authority)
- [ ] Reading the draft exactly as ODPC will see it
- [ ] Both Engineer and James sign-off timestamps present
- [ ] ODPC portal URL current (verified within 24h of send)
- [ ] Filing submitted via founder-authenticated portal login
- [ ] Cc: compliance@tumafly.com if portal supports (or manual after)
- [ ] Sent copy saved to `docs/incident/filed/TF-INC-YYYYMMDD-NN_odpc_filing.md`
- [ ] Ops notified of send timestamp for incident tracker

## After send

- [ ] Ops tracks ODPC acknowledgment (expected 24-48h under normal load)
- [ ] Ops logs the filing in incident tracker (`docs/incident/log.md`)
- [ ] Ops sets 48h reminder to check for acknowledgment; escalates to founder if silent
- [ ] Ops prepares customer §43(3) notifications per `customer_breach_notification_template.md` if applicable
- [ ] Engineer continues investigation; prepares §43(4) update filing if new facts emerge
- [ ] Post-incident review scheduled per SOP §4.9 (minimum 7 days post-containment)
- [ ] Founder considers whether Duffel / Paystack / Supabase / Cloudflare / Resend need parallel notifications per SOP §4.6

---

## References

- **Kenya Data Protection Act 2019 §43** — Notification of Personal Data Breach
- **Kenya Data Protection (General) Regulations 2021** — Breach notification procedure
- **SOP §4.2** — Data breach protocol
- **SOP §4.5** — Post-incident review process
- **SOP §4.6** — Notification obligations (role-attributed table)
- **SOP §4.7** — Remediation
- **SOP §4.8** — Escalation matrix
- **SOP §4.9** — Post-mortem
- **Session 33 hiring brief (security role)** — Engineer incident response responsibilities
- **Session 35d hiring brief (Ops/Support)** — Tier 1 / Tier 2 split, §5, §50, §70
- **`docs/incident/customer_breach_notification_template.md`** — Companion for §43(3) direct notifications
- **`docs/incident/internal_incident_report_template.md`** — Companion for post-mortem
- **`docs/security/saved_travelers_encryption.md`** — pgcrypto encryption reference for §3 attestation

---

## Version history

- **v0.1** (Session 35b close, 2026-08-19) — first draft; Owner blocks under-specified
- **v0.2** (Session 35b close revised, 2026-08-19) — Owner blocks aligned to Session 33 + Session 35d hiring briefs; per-role operator checklists; pgsodium references corrected to pgcrypto (Session 36 shipped as pgcrypto)

---

*This is a template. It becomes the basis for a specific notification once a breach is confirmed; do NOT send this document as-is. Every bracketed item must be replaced with confirmed facts. Ops drafts; Engineer + James review; Founder sends.*