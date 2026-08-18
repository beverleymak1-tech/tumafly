# TumaFly DNS Security Configuration

**Domain:** tumafly.com
**Registrar:** Cloudflare Registrar
**DNS provider:** Cloudflare DNS
**Owner:** Founder (Bev)
**KYC alignment:** supporting evidence for KYC §1.8 (edge posture) and §2 (email security)
**Introduced:** Session 35d (2026-08-15)

---

## 1. Purpose + scope

Source-of-truth attestation for DNS-layer security configuration on tumafly.com. This sits below application-layer WAF (`docs/security/cloudflare_waf_config.md`) and covers controls that operate at the DNS resolution and email-authentication layer.

**In scope:** CAA records, DNSSEC, email-authentication records (SPF, DKIM, DMARC), DMARC aggregate report ingestion.

**Out of scope:** application-layer WAF (see `cloudflare_waf_config.md`), response headers (see `frontend/_headers`), Edge Function protection (see Security Framework doc).

---

## 2. Configuration inventory

### 2.1 CAA — Certificate Authority Authorization

**Target state:** CAA records naming only trusted CAs as authorized to issue certificates for tumafly.com.

**Records to add:**
```
tumafly.com. CAA 0 issue "letsencrypt.org"
tumafly.com. CAA 0 issue "pki.goog"
tumafly.com. CAA 0 issue "digicert.com"
tumafly.com. CAA 0 issuewild ";"
tumafly.com. CAA 0 iodef "mailto:security@tumafly.com"
```

**Rationale:**
- `issue "letsencrypt.org"` — Cloudflare's default cert issuance path
- `issue "pki.goog"` and `"digicert.com"` — Cloudflare backup CAs (they rotate between issuers)
- `issuewild ";"` — disallows wildcard cert issuance (we don't use them; explicit denial hardens against misconfig)
- `iodef` — where CAs report unauthorized issuance attempts

**How to configure:**
- Dashboard → tumafly.com → DNS → Records → Add record → Type: CAA (repeat for each row above)

**Observed state:** All 5 explicit CAA records deployed 2026-08-16. Verified via `dig +short CAA tumafly.com @1.1.1.1`:
- `0 issue "letsencrypt.org"`
- `0 issue "pki.goog; cansignhttpexchanges=yes"` *(Cloudflare adds cansignhttpexchanges parameter)*
- `0 issue "digicert.com; cansignhttpexchanges=yes"` *(same)*
- `0 issuewild ";"`
- `0 iodef "mailto:security@tumafly.com"`

Cloudflare auto-injects additional CAA records per SSL/TLS configuration (`ssl.com`, `comodoca.com`, plus `issuewild` variants of each authorized CA). Documented Cloudflare behavior — see https://developers.cloudflare.com/ssl/edge-certificates/caa-records/#caa-records-added-by-cloudflare

**Screenshot:** `docs/security/screenshots/s13_caa.png`

---

### 2.2 DNSSEC

**Target state:** enabled at Cloudflare with DS record registered at registrar.

**Rationale:** cryptographically signs DNS responses so resolvers detect tampering in transit. Protects against DNS cache poisoning and hijacking — the class of attacks that reroutes tumafly.com to an attacker's server without touching the Cloudflare account itself.

**How to configure:**
- Step A: Dashboard → tumafly.com → DNS → Settings → DNSSEC → Enable
- Step B: Cloudflare displays a DS record → Dashboard → Registrar (Cloudflare Registrar for tumafly.com) → Domain Overview → DS Records → paste the record

**Observed state:** DNSSEC enabled at Cloudflare DNS + Active at Cloudflare Registrar as of 2026-08-16. DS record auto-provisioned (Cloudflare Registrar + Cloudflare DNS in same account — no manual DS registration required). Fully validated end-to-end verified via:

`dig +short DS tumafly.com @1.1.1.1`:
- `2371 13 2 34584C7C65BC8B6871AB476EEF513EB2D039A63B23DBB4ADAB960A69 85F3D212`

Algorithm: ECDSA with SHA-256 (algorithm 13). Digest type: SHA-256 (type 2).

`dig tumafly.com +dnssec @1.1.1.1` returns `ad` flag in response header, confirming cryptographic validation by resolver. RRSIG records present across all zone record types.

**Screenshots:**
- `docs/security/screenshots/s13_dnssec.png` — current state (Registrar Settings: DNSSEC Active)
- `docs/security/screenshots/s13_dnssec_pending.png` — enable-time state (DNS Settings: "DNSSEC is pending while we automatically add the DS record on your domain") documenting Cloudflare Registrar auto-provisioning behavior

---

### 2.3 SPF — Sender Policy Framework

**Target state:** SPF deployed on tumafly.com apex authorizing all senders that use `@tumafly.com` envelope-from.

**Verification:**
```bash
dig +short TXT tumafly.com @1.1.1.1
```

**Observed state:** Apex SPF deployed 2026-08-17 after being found missing during Session 35d verification pass (Playbook §7 drift — SPF was on `send.tumafly.com` subdomain only; apex had no SPF).

`dig +short TXT tumafly.com @1.1.1.1`:
- `"v=spf1 include:_spf.google.com ~all"` (apex — authorizes Google Workspace outbound)
- `"google-site-verification=0gavnV15ufcz2MG03LUnUgYMiYGQqQ2KukBbQLTEsPU"` (unrelated)

Subdomain SPF also present:
- `send.tumafly.com` TXT: `"v=spf1 include:amazonses.com ~all"` (Resend/SES transactional envelope-from)

Empirical validation via live send from `alerts@tumafly.com` (Google Workspace) to external Gmail 2026-08-17: `SPF: PASS with IP 209.85.220.41`.

---

### 2.4 DKIM — DomainKeys Identified Mail

**Target state:** DKIM keys deployed for all authorized senders (Google Workspace + Resend).

**Verification:**
```bash
dig +short TXT google._domainkey.tumafly.com @1.1.1.1
dig +short TXT resend._domainkey.tumafly.com @1.1.1.1
```

**Observed state:** Two DKIM keys deployed on tumafly.com:
- `google._domainkey.tumafly.com` — well-formed record with full `v=DKIM1;k=rsa;p=...` prefix, signs Google Workspace outbound mail
- `resend._domainkey.tumafly.com` — record starts with `p=...` (no explicit `v=`/`k=` tags). This is Resend's canonical format — verified 2026-08-17 in Resend dashboard as Verified. See §5.1 — investigated and closed.

Empirical validation via live send 2026-08-17: `DKIM: 'PASS' with domain tumafly.com` — Google-selector DKIM signature validates correctly at Gmail.

---

### 2.5 DMARC — Domain-based Message Authentication, Reporting & Conformance

**Target state:** DMARC deployed with policy `p=quarantine` and dual-ingestion aggregate reporting (parsed digest + raw archive).

**Verification:**
```bash
dig +short TXT _dmarc.tumafly.com @1.1.1.1
```

**Observed state:** DMARC deployed with policy `p=quarantine`. Dual-ingestion architecture deployed Session 35d (2026-08-17).

`dig +short TXT _dmarc.tumafly.com @1.1.1.1`:
- `"v=DMARC1; p=quarantine; rua=mailto:re+vziiql8vdh6@dmarc.postmarkapp.com, mailto:dmarc@tumafly.com; aspf=r; adkim=r"`

**Report ingestion:**

1. **Postmark DMARC Weekly Digest** — parsed, human-readable summary emailed weekly (Monday mornings) to `security@tumafly.com`. Postmark dashboard shows tumafly.com verified 2026-08-17. Free tier; account signed up with `security@tumafly.com`.
2. **Google Group `dmarc@tumafly.com`** — raw XML archive of every RFC 7489 aggregate report. Group forwards to founder's personal Gmail. External posting enabled (required for receivers like Gmail/Yahoo/Microsoft to deliver reports); membership open to organization. External-delivery verified 2026-08-17 by test send from `tumelowrites@proton.me` → landed successfully via forwarding.

**Rationale for dual ingestion:** Postmark provides usable weekly signal for routine review; Google Group preserves raw XMLs for audit-grade evidence and post-incident forensic analysis. Belt-and-suspenders — if Postmark ever has an outage, reports still land in the Google Group.

**Subdomain policy:** absent `sp=` tag means subdomains inherit main policy (`p=quarantine`) per RFC 7489. Google's first aggregate report (see below) echoed back `sp=quarantine` AND `np=quarantine` (non-existent subdomain policy) as inherited from the main `p=` value, confirming the inheritance works as expected without needing explicit tags.

**Empirical validation:**

- **Live send-test 2026-08-17:** `DMARC: 'PASS'` at Gmail receiver — full authentication chain (SPF PASS + DKIM PASS + relaxed alignment on both) evaluates DMARC PASS.

- **First DMARC aggregate report from Google received 2026-08-17** (within 24h of deployment) — validates full ingestion chain functioning end-to-end. Report filename `google.com!tumafly.com!1786838400!1786924799.xml` covering the 24-hour observation window. Contents:
    - 1 message observed from source IP `209.85.220.41` (Google Workspace outbound MTA — matches send-test)
    - SPF: PASS with domain `tumafly.com`
    - DKIM: PASS with `google` selector, domain `tumafly.com`
    - DMARC disposition: `none` (message passed all checks, no policy action)
    - Google's report echoed policy as `p=quarantine, sp=quarantine, np=quarantine, adkim=r, aspf=r` — confirms subdomain policy inheritance working
    - Report delivered successfully to `dmarc@tumafly.com` Google Group + forwarded to founder Gmail (confirms Google Group external-posting permission correctly configured)

Cross-checks: (a) Postmark, (b) Google Group raw XML archive, (c) send-test — all three converge on "authentication chain healthy, ingestion working."

**Screenshots:**
- `docs/security/screenshots/s13_dmarc_postmark.png` — Postmark verified state
- `docs/security/screenshots/s13_dmarc_google_group.png` — Google Group config showing external posting enabled

---

## 3. Verification

### 3.1 CAA lookup

```bash
dig +short CAA tumafly.com
```

Expected: all five records above.

### 3.2 DNSSEC validation

```bash
dig tumafly.com +dnssec +short
delv tumafly.com
```

Expected: `RRSIG` records present; `delv` reports "fully validated".

### 3.3 Email-auth external audit

https://mxtoolbox.com/domain/tumafly.com/ — should show green on SPF, DKIM, DMARC.

Alternatively, live send-test: send from any `@tumafly.com` mailbox to an external Gmail; use Gmail's "Show original" view to confirm SPF/DKIM/DMARC PASS in the authentication summary.

### 3.4 DMARC ingestion — external delivery test

```
From: any external address (e.g., personal Gmail, ProtonMail)
To: dmarc@tumafly.com
Subject: External post test
```

Expected: delivered without bounce; forwards to configured Google Group member(s). If bounces with "you may not have permission to post," Google Group's external posting permission is misconfigured (see §2.5).

### 3.5 DMARC ingestion — passive validation

After ~24h of deployment, first Google aggregate report should arrive at `dmarc@tumafly.com`. Filename pattern `google.com!tumafly.com!<start-ts>!<end-ts>.xml`. Absence after 24-48h suggests ingestion misconfiguration.

Weekly: Postmark digest arrives Monday morning at `security@tumafly.com`.

---

## 4. Rollback

- CAA: delete records (immediate; Cloudflare cert issuance falls back to prior behaviour)
- DNSSEC: disable at Cloudflare + remove DS record at registrar (immediate but propagation up to 24h)
- SPF / DKIM / DMARC: do NOT delete — email deliverability depends on them
- DMARC ingestion: removing Postmark ingestion address from `rua=` disables Postmark digests immediately (Postmark stops receiving reports after DNS propagates). Removing `dmarc@tumafly.com` from `rua=` disables raw archive. `alerts@tumafly.com` no longer receives DMARC reports (removed from `rua=` Session 35d — reverting requires re-adding to DMARC record).

---

## 5. Backlog / deferred items

### 5.1 Resend DKIM record format — documented behavior (closed)

`resend._domainkey.tumafly.com` TXT record starts with `p=...` and omits the `v=DKIM1;k=rsa;` prefix. This is Resend's canonical format — verified 2026-08-17 that the Resend dashboard displays the record in exactly this shape with Status: Verified, and empirical send-test to Gmail returned `DKIM: 'PASS' with domain tumafly.com`. Per RFC 6376, `v` and `k` tags default to `DKIM1` and `rsa` respectively when absent, so the record is fully compliant.

No action required. Investigated Session 35d during DNS documentation pass.

---

### 5.2 DMARC policy tightening — quarantine to reject (two-stage)

**Stage 1 (post-launch + 4 weeks): Review Postmark weekly digests.**
Confirm no legitimate mail is being quarantined. Look for: unexpected sending sources (mail from IPs we don't recognize), pass rate drops, spoof attempt patterns. Cross-check against the raw XML archive in the `dmarc@tumafly.com` Google Group for anomalies not surfaced in the digest summary.

**Stage 2 (once Stage 1 clean): Tighten `p=quarantine` to `p=reject`.**
5-minute DNS edit: change `p=quarantine` to `p=reject` in `_dmarc.tumafly.com` TXT record. Also consider adding explicit `sp=reject` at this point rather than relying on inheritance (belt-and-suspenders on subdomain protection).

**Rationale for two-stage:** DMARC tightening at `p=reject` without observation data is the standard way to lose transactional email at 3am. The 4-week observation window is the industry-standard safety period. The dual-ingestion architecture (Postmark + Google Group) exists specifically to make Stage 1 low-effort.

---

### 5.3 Google Group `dmarc@tumafly.com` — membership access design decision

**Current setting:** "Anyone in the organization can join." Any Google Workspace user under `@tumafly.com` can self-join without approval and start receiving DMARC XML reports.

**Rationale:** DMARC aggregate reports contain sending-IP metadata, receiver-domain counts, and authentication outcomes — internal-only sensitivity, but not "highly confidential" (no customer PII, no message content, no credentials). For a growing team, self-service group access reduces founder-attention interrupts and distributes visibility into mail-flow health.

**Revisit trigger:** if TumaFly ever adds contractors, part-timers, or external consultants with `@tumafly.com` addresses who should NOT see infrastructure signals, tighten to "Only invited users" and manage membership per-hire.

Established Session 35d.

---

## 6. Change management

See SOP Master §6 — Configuration Change Management.

---

## 7. Deployment record

**Configured:**
- CAA records: 2026-08-16
- DNSSEC: 2026-08-16
- Apex SPF: 2026-08-17 (closed pre-existing Playbook §7 drift)
- DKIM (Google + Resend selectors): pre-Session-35 (verified 2026-08-17)
- DMARC policy `p=quarantine`: pre-Session-35 (verified 2026-08-17)
- DMARC dual-ingestion (Postmark + Google Group): 2026-08-17
- First Google DMARC aggregate report received: 2026-08-17 (within 24h — validates full ingestion chain)

**Configured by:** Founder (Bev)
**Session:** 35d

---

*End of DNS security configuration. First landed Session 35d (2026-08-15).*