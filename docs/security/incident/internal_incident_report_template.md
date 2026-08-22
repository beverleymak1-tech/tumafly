# Internal Incident Report Template

**Location:** `docs/incident/internal_incident_report_template.md`
**Purpose:** structured post-mortem after an incident to capture root cause, extract institutional learning, and track preventive commitments. Internal-only document; NOT for external distribution.
**Version:** v0.2 (revised for Session 35b close, 2026-08-19) — supersedes v0.1

---

## Ownership + execution

| Role | Responsibility |
|---|---|
| **Draft author** | Ops/Support (Tier 1) — per Session 35d Ops/Support hiring brief §5.6 (documentation upkeep), §37 (post-mortem drafts), §70 (draft via SOP §4 template) |
| **Technical + classification sign-off** | Engineer (Tier 2) — per hiring brief §70 (sign off on classification + code changes) |
| **Founder sign-off** | Required before action items formally close |
| **Storage** | git repo at `docs/incident/reports/TF-INC-YYYYMMDD-NN_internal_report.md` (same incident ID as ODPC filing + customer notification if applicable) |
| **Template maintainer** | Ops/Support (currently founder pre-hire) — bottom-up engineering culture document; updated by whoever most recently ran a post-mortem and noticed the template failing them |
| **Template review triggers** | Ops-1 hire, Ops-2 hire, post-incident findings surfacing template gaps, quarterly review |

**Pre-Ops-1 (current state):** founder drafts, engineer role held by founder, founder signs off. Every role collapses to one person.

**Referenced from:** SOP §4.9 (Post-mortem process); role definitions: Session 33 security role hiring brief + Session 35d Ops/Support hiring brief §5.6, §37, §70.

---

## When to write one

**Trigger:** every incident classified as HIGH or CRITICAL severity (S1/S2) per SOP §4.1 alert response matrix, regardless of whether it resulted in a data breach requiring ODPC notification. Also for near-miss incidents (would have been S1/S2 if not for compensating controls) that surface systemic risk worth capturing.

**Do NOT write one for:**
- INFO or WARN severity events (S3/S4 — routine, alert system working as designed)
- Individual failed authentication attempts (background noise)
- Third-party outages that resolved without our intervention
- Alert firing without incident (false positive from an aggregate threshold)

**Blameless posture:** internal incident reports are for learning, not accountability. The report focuses on system + process root causes, not individual mistakes. Individual conduct issues (rare) go through separate performance review channels.

## Timing

- **Immediate:** rough notes captured during incident response (Ops maintains timeline in real-time; see SOP §4.4)
- **7 days post-containment:** Ops full draft complete (this template)
- **14 days post-containment:** report review meeting with all incident participants + founder (Ops facilitates)
- **30 days post-containment:** all High-priority action items closed OR their owner has explicitly flagged blocking issues
- **Quarterly:** Ops reviews outstanding action items across all past incidents

## Distribution

**Internal only.** This report contains:
- Speculation about root causes before they're publicly confirmed
- Candid assessment of what didn't work in response
- Individual actions (attributed without judgment)
- Specific system vulnerabilities and their remediation status

**Sharing outside TumaFly requires founder approval.** If asked by ODPC or Duffel to share incident details, share the ODPC filing + customer notification instead — those are the external-facing versions with appropriate sanitization.

**Storage:** `docs/incident/reports/TF-INC-YYYYMMDD-NN_internal_report.md` — access via git-controlled repo access (currently: founder-only; expands with Ops-1).

---

## Report structure

Below is the template. Ops fills honestly. When in doubt, over-share internally — the value of this report is what a future engineer or ops person learns from it.

---

## TumaFly Incident Report: [TF-INC-YYYYMMDD-NN]

### Header block

| Field | Value |
|---|---|
| **Incident ID** | TF-INC-YYYYMMDD-NN |
| **Severity** | [CRITICAL (S1) / HIGH (S2)] |
| **Triggering alert(s)** | [e.g. PAID_NO_TICKET x 3, then DUFFEL_MODE_KEY_MISMATCH] |
| **Awareness time** | HH:MM EAT DD Month YYYY |
| **Containment time** | HH:MM EAT DD Month YYYY |
| **Total containment duration** | Xh Ym |
| **Data breach?** | [Yes / No / Under investigation] |
| **ODPC notification filed?** | [Yes / No / Not required — reasoning] |
| **Customer notification sent?** | [Yes / No / Not applicable] |
| **Affected customers (approximate)** | [count or "none"] |
| **Report drafted by** | Ops: [name] |
| **Report drafted on** | DD Month YYYY |
| **Engineer sign-off (technical + classification)** | [name + timestamp] |
| **Report reviewed by** | [names of review meeting participants] |
| **Review meeting date** | DD Month YYYY |
| **Founder sign-off** | [name + timestamp] |

### 1. Executive summary

[Ops drafts. Two paragraphs, ~200 words. Written for someone reading this report 6 months from now who has no context. Cover:
- What happened, in one sentence
- Impact scope
- Root cause, in one sentence (Engineer contributes root cause language)
- Key remediation
- Most important learning]

### 2. Timeline (reconstructed)

[Ops reconstructs from real-time notes + engineer input. Chronological account of what happened, in EAT. Include:
- Actual event times, not response times
- Named actors (System, Ops, Engineer, Founder, [name], etc.)
- Both what was observed AND what was inferred

Format:

| Time (EAT) | Actor | Event / Action |
|---|---|---|
| DD MMM HH:MM | System | [event description] |
| DD MMM HH:MM | Ops | [action taken] |
| DD MMM HH:MM | Engineer | [action taken] |
| DD MMM HH:MM | System | [subsequent event] |
| ... | ... | ... |
| DD MMM HH:MM | Founder | Incident declared contained. |

Include pre-incident timeline too — when the root cause was introduced, when it first went undetected, etc. Engineer contributes pre-incident timeline reconstruction.]

### 3. Root cause analysis

[Engineer contributes; Ops formalizes into report language.]

**Immediate cause:** [The specific technical or process failure that triggered the incident. One sentence.]

**Contributing factors:** [The conditions that allowed the immediate cause to have this impact. Multiple sentences OK.]

**Latent conditions:** [The systemic issues that made this failure mode possible. Examples: missing test coverage, deferred backlog items, unclear ownership, insufficient monitoring for the failure class, unchecked assumptions in a shared helper.]

**Five whys** (or as many as needed to reach a system-level cause):
1. Why did [immediate cause] happen? → Because [answer]
2. Why did [that] happen? → Because [answer]
3. Why did [that] happen? → Because [answer]
4. Why did [that] happen? → Because [answer]
5. Why did [that] happen? → Because [answer]

Stop when the answer is a systemic condition that we can act on. Don't stop at "human error" — that's rarely a root cause.

### 4. Impact assessment

[Ops drafts customer + business impact from support data; Engineer confirms technical impact assessment.]

**Customer impact:**
- Number of customers affected: [count]
- Nature of impact: [e.g. "confirmation emails delayed by X hours" or "booking status stuck in duffel_pending for X hours"]
- Financial impact to customers: [KES amount or "none"]
- Trust impact: [qualitative — how visible was this to customers?]

**Business impact:**
- Bookings lost / abandoned: [count or estimate]
- Revenue impact: [KES amount or estimate]
- Duffel supplier impact: [e.g. "3 unauthorized cancellations required by Duffel; no supplier action needed"]
- Regulatory impact: [ODPC exposure, Duffel KYC restatement, etc.]

**Team impact:**
- Person-hours spent on response: [total across Ops + Engineer + Founder]
- Impact on other work: [what got deprioritized during response]
- Emotional impact: [honest assessment — incidents wear people down; naming it helps sustainability]

### 5. Detection

**How was the incident detected?** [Alert / customer report / staff observation / third-party notification / audit]

**Time from root cause to detection:** [minutes/hours/days — the latency between the condition being present and Ops/Engineer noticing]

**Was detection as fast as it could have been?** [Yes/No — if no, why not?]

**Were there earlier indicators that should have been noticed?** [Reviewing logs + alerts leading up to the incident — was there a warning sign that Ops's Tier 1 review should have caught?]

**Detection improvements needed:** [Specific — new alerts, new dashboards, new review cadence?]

### 6. Response

[Ops drafts; Engineer + Founder review + augment.]

**What went well:**
- [Specific positive action or system behavior]

**What didn't go well:**
- [Honest — where did response falter? Was containment slower than it should have been? Did we contact the wrong person first? Did we make the situation worse before making it better?]

**What surprised us:**
- [Anything unexpected during response — system behavior, third-party response times, tooling gaps]

**Response improvements needed:**
- [Specific — runbook additions, tooling changes, escalation path clarifications]

### 7. Action items

[Ops maintains tracker; owners execute; Engineer + Founder assign owners during 14-day review meeting.]

Every action item has:
- **Owner** (a specific person, not a team)
- **Deadline** (a specific date, not "ASAP")
- **Priority** (High / Medium / Low)
- **Success criterion** (how we'll know it's done)
- **Tracking issue** (link to Roadmap / issue tracker / etc.)

**High priority (target: <30 days):**

| Item | Owner | Deadline | Success criterion | Tracking |
|---|---|---|---|---|
| [Concrete action] | [name] | DD Mon YYYY | [measurable outcome] | [link] |

**Medium priority (target: <90 days):**

| Item | Owner | Deadline | Success criterion | Tracking |
|---|---|---|---|---|
| [Concrete action] | [name] | DD Mon YYYY | [measurable outcome] | [link] |

**Low priority (target: quarterly review):**

| Item | Owner | Deadline | Success criterion | Tracking |
|---|---|---|---|---|
| [Concrete action] | [name] | DD Mon YYYY | [measurable outcome] | [link] |

### 8. Lessons learned

[Ops drafts; all participants contribute during review meeting. Free-form. What did we learn that will help future incidents?

- **New knowledge:** something we didn't know before that we should share broadly
- **Reinforced knowledge:** something we knew in principle but this incident made real
- **Contradicted knowledge:** something we thought was true that isn't

Include cultural + process lessons — how did our Tier 1 / Tier 2 handoff work? Where did our processes support us and where did they fail us?]

### 9. Anti-patterns to avoid

[Ops + Engineer identify. Behaviors, decisions, or system designs that contributed to this incident that we should call out as anti-patterns for the future.

Example (illustrative):
- Silent shared-helper duplications: three EFs each carry a local copy of the mode-key check; if one drifts, we won't notice until the specific EF's failure mode surfaces
- Post-refactor grep-only verification: refactors that touch env var reads should include a runtime smoke test, not just a grep
- Assumption of Supabase env var naming stability: `SUPABASE_*` prefixes are Supabase's namespace, not ours; treating them as interchangeable with our own `SERVICE_ROLE_KEY` naming is a category error]

### 10. Sign-off

| Role | Name | Sign-off date | Notes |
|---|---|---|---|
| Ops (report author) | [name] | DD Mon YYYY | |
| Engineer (technical + classification) | [name] | DD Mon YYYY | |
| Founder (final) | [name] | DD Mon YYYY | Includes any strategic action items assigned |
| James (advocate) | [name] | DD Mon YYYY | Only for reports where incident had regulatory dimension |

---

## Companion documents

- **`odpc_notification_template.md`** — if incident required ODPC filing
- **`customer_breach_notification_template.md`** — if incident triggered §43(3)
- **`docs/incident/reports/`** — this report's persistent location
- **`docs/incident/log.md`** — running incident log (all reports referenced here; Ops maintains)

## Quarterly review

Every quarter, Ops leads a review of past incident reports against:

- Have all High-priority action items closed?
- Are any Medium-priority items overdue?
- Are the lessons learned reflected in updated SOPs / RUNBOOK / docs/security?
- Have similar incidents recurred? If so, why didn't this report's preventive measures stop them?

If action items are chronically overdue: escalate to Engineer + Founder. Either the priority was wrong, the estimated effort was wrong, or the owner is under-resourced. Named and addressed, not left to slip.

---

## Operator checklist by role

### Ops/Support (drafter + coordinator)
- [ ] Real-time timeline captured during incident response
- [ ] Draft complete within 7 days of containment
- [ ] All sections populated (Executive summary → Anti-patterns)
- [ ] Engineer input on root cause + technical accuracy secured before draft finalized
- [ ] 14-day review meeting scheduled + all participants invited
- [ ] Draft placed at `docs/incident/reports/TF-INC-YYYYMMDD-NN_internal_report.md`
- [ ] Action items tracker started (`docs/incident/action_items.md`)

### Engineer (technical + classification sign-off)
- [ ] Root cause analysis technically accurate
- [ ] Classification (severity, breach yes/no) correct
- [ ] Anti-patterns section captures real engineering learnings
- [ ] Any code changes committed with reference to this incident ID
- [ ] Sign-off written to report with timestamp before founder review

### Founder (final sign-off)
- [ ] All action items have owners + deadlines
- [ ] Strategic action items (backlog additions, resourcing, external comms) assigned
- [ ] Sign-off written to report with timestamp
- [ ] Report closed in incident log

---

## Tone guidance for report authors

- **Blameless.** Address system + process, not individuals. "The refactor introduced X" not "[Person] made a mistake."
- **Specific.** "The alert misfired" is not a root cause. "The alert fired but was routed to an unmonitored inbox because FOUNDER_EMAIL was hardcoded in the EF" is a root cause.
- **Honest.** If we fumbled the response, say so. Reports that sanitize response failures teach nothing.
- **Actionable.** Every finding should lead to either an action item or an explicit "no action needed, and here's why."
- **Written for the reader in 6 months.** Assume no context. Explain acronyms. Link to code + docs.

## Failure modes to avoid in the report itself

- **Turning it into a status report.** This is a learning document, not a work log.
- **Deferring hard questions.** If you don't know why something happened, say so and open an investigation action item.
- **Copy-pasting from prior reports.** Every incident is different; templated language obscures real learning.
- **Making it a blame document.** If you find yourself writing "should have," rewrite as "the system should support..."
- **Skipping the sign-off.** Unsigned reports don't get acted on.

## References

- **SOP §4.1** — Alert severity → response matrix (S1/S2 triggers this template)
- **SOP §4.5** — Post-incident review process
- **SOP §4.9** — Post-mortem
- **Session 33 hiring brief** — Engineer role in incident response
- **Session 35d hiring brief §5.6, §37, §70** — Ops/Support role in post-mortem drafting
- **RUNBOOK** — Operator diagnostics for common incident classes
- **`odpc_notification_template.md`** — Statutory external filing
- **`customer_breach_notification_template.md`** — Data subject notification

---

## Version history

- **v0.1** (Session 35b close, 2026-08-19) — first draft; assumed engineer-drafts model
- **v0.2** (Session 35b close revised, 2026-08-19) — Ops-drafts model per Session 35d hiring brief §5.6, §37, §70; Engineer signs off on technical accuracy + classification; per-role operator checklists

---

*This is a template. It becomes the basis for a specific incident report once an incident is contained. Every bracketed item must be replaced with incident-specific facts. Report must be reviewed with all incident participants before sign-off. Ops drafts; Engineer + Founder sign off.*