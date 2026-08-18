# TumaFly Cloudflare WAF Configuration

**Domain:** tumafly.com (Cloudflare Pages)
**Owner:** Founder (Bev)
**KYC alignment:** closes gap 1.8 (Cloudflare WAF configured + documented at edge)
**Introduced:** Session 35d (2026-08-15)
**Cloudflare plan:** Free tier (Pro upgrade gated on TRA business milestone — see §5)

---

## 1. Purpose + scope

Source-of-truth attestation for the Cloudflare edge-security configuration protecting `tumafly.com`'s frontend surface. Referenced by KYC §1.8 and the Security Framework doc's technical-controls section.

**In scope:** Managed Rules (deferred), OWASP CRS (deferred), Rate Limiting on frontend, custom firewall rules on frontend, TLS posture, Cloudflare Notifications, autonomous detection tools inventory.

**Out of scope:**
- Response headers (HSTS / CSP / X-Frame-Options / Referrer-Policy / Permissions-Policy) — ship via `frontend/_headers` (S-01).
- DNS-layer controls (CAA / DNSSEC / SPF / DKIM / DMARC) — see `docs/security/dns_config.md`.
- Edge Function surface protection — EFs are called direct-to-Supabase and are protected at Supabase edge + application layer (S-07 OTP throttle, S-11 guest-token threshold). Composed narrative lives in the Security Framework doc.

---

## 2. Configuration inventory

### 2.1 Managed Rules — Cloudflare Managed Ruleset

**Target state:** enabled at Cloudflare defaults (Managed Challenge for medium-risk, Block for high-risk).

**Current state:** deferred until Cloudflare Pro upgrade (see §5.1).

**Rationale for deferral:** Managed Rules requires Pro plan ($20/mo). Pro upgrade is gated on TRA business milestone — deferring paid infrastructure until we have a clear operational baseline is the sequencing decision. Compensating controls layer covers this deferral (see §2.4 autonomous Security Level, §2.7 detection tools, and out-of-scope application-layer defenses in Framework doc).

**Post-upgrade migration task:**
- Dashboard → tumafly.com → Security → WAF → Managed rules → Deploy "Cloudflare Managed Ruleset"
- Leave rule actions at ruleset defaults unless verification surfaces false-positives
- Update §2.1 Observed state with deployment date + screenshot
- No SOP §6 config-change entry needed — this is initial enable, not a modification of existing state

**Observed state:** Not enabled — free plan limitation. Cloudflare Security Overview → Managed rules panel shows "Upgrade plan" prompt.

**Screenshot:** deferred until enable

---

### 2.2 OWASP Core Rule Set

**Target state:** enabled at Paranoia Level 1 (Cloudflare default; higher levels have high false-positive rates for legitimate JSON APIs).

**Current state:** deferred until Cloudflare Pro upgrade (see §5.1).

**Rationale for deferral:** OWASP CRS requires Pro plan. Ships alongside §2.1 Managed Rules on same upgrade. Not blocking pre-launch — combined with §2.4 autonomous protection provides baseline defense.

**Post-upgrade migration task:**
- Dashboard → tumafly.com → Security → WAF → Managed rules → Deploy "Cloudflare OWASP Core Ruleset"
- Paranoia Level: 1 (default)
- Update §2.2 Observed state with deployment date + screenshot

**Observed state:** Not enabled — free plan limitation.

**Screenshot:** deferred until enable

---

### 2.3 Rate Limiting — frontend surface

**Target state:** one rate-limit rule (free-tier ceiling) protecting the tumafly.com frontend from crawler and enumeration abuse.

**Configuration (as deployed on free tier):**
- Rule name: `frontend-per-IP-100req-10s`
- Field: Hostname — expression: `(http.host eq "tumafly.com")` (entered via Expression Editor; not exposed in the free-tier visual field-builder dropdown — see §5.3 diagnostic note)
- Characteristics: IP address
- Requests: 100 per 10 seconds
- Action: Block
- Duration: 10 seconds

**Rationale for 100 req / 10 seconds:** normal browsing session with page assets (fonts, images, JS) peaks around 60-80 requests during a page-load burst window. 100 gives ~25-40% headroom for legitimate use including rapid double-reloads. Sustained rate required to trip: 10 rps — well above normal browsing (which drops to near-zero after page load since all subsequent app activity is EF calls direct to Supabase, not to Cloudflare). Enumeration scanners typically run 20-50 rps and trip immediately. Volumetric attacks handled separately by Cloudflare's baseline L3/L4 DDoS protection.

**Free-tier constraints (documented for future reference):**

| Constraint | Free tier | Pro tier |
|---|---|---|
| Rate-limit rule count | 1 | 15 |
| Period | Locked at 10 seconds | Configurable (10s to 1 day) |
| Duration | Locked at 10 seconds | Configurable |
| Action | Block only | Block + Managed Challenge + JS Challenge + Log |
| Hostname field in visual builder | Not exposed | Exposed |
| Raw expression editor | Available (workaround) | Available |

**Post-upgrade migration task** (on Cloudflare Pro upgrade — see §5.1):
- Rename rule: `frontend-per-IP-100req-10s` → `frontend-per-IP-300rpm`
- Change Requests: 100 → 300
- Change Period: 10 seconds → 1 minute
- Change Duration: 10 seconds → 1 minute
- Change Action: Block → Managed Challenge (softer on legitimate users who accidentally trip)
- Same expression, same characteristic — no other changes
- Update §2.3 Observed state + re-screenshot + SOP §6 change entry

**How to configure (current free-tier setup):**
- Dashboard → tumafly.com → Security → WAF → Rate limiting rules → Create rule
- In the "When incoming requests match" section, click "Edit expression" (top-right of Expression Preview panel)
- Paste: `(http.host eq "tumafly.com")`
- Fill other fields per configuration above

**Observed state:** Rule `frontend-per-IP-100req-10s` deployed 2026-08-18. Free-tier constraints (Period + Duration + Action) accepted as interim shape. Verified via dashboard rule listing showing Active status. Post-Pro-upgrade reconfiguration path documented above.

**Screenshot:** `docs/security/screenshots/s13_rate_limit.png`

---

### 2.4 Cloudflare Autonomous Security Level

**Target state:** Cloudflare's autonomous "Always protected" Security Level active — automated protection combining real-time DDoS scoring, traffic thresholds, and continuously-updated botnet tracking.

**Rationale (why this replaced the originally-scaffolded custom threat-score rule):**

The original S-13 spec called for a custom rule using the `cf.threat_score` field to block IPs with reputation scores above a threshold. Cloudflare **deprecated `cf.threat_score` as a manually-configurable field** in March 2025 ([Cloudflare blog reference](https://blog.cloudflare.com/enhanced-security-and-simplified-controls-with-automated-botnet-protection/)), citing well-documented false-positive problems as CGNATs, VPNs, WARP, and outbound proxies became common — a single "bad" IP might actually be hundreds of legitimate users sharing an outbound gateway. By end of Q1 2026, all rules relying on IP threat score were disabled.

The replacement is **stronger than the manual rule would have been**:

- Combines IP reputation with real-time DDoS behavioral scoring + continuously-updated botnet database + traffic threshold detection
- Continuously refreshed across Cloudflare's global network (~20% of all websites)
- Fewer false positives on CGNAT/VPN traffic — meaningful for East African audiences on mobile-carrier NAT
- Zero maintenance burden — no threshold to tune, no rule to manage
- Applied earlier in request lifecycle (before custom rules)
- No tier gate — free tier gets same protection as Enterprise

**How to verify:**
- Dashboard → tumafly.com → Security → Security Overview → right-side Detection tools panel
- Confirm "Managed rules" / "DDoS attacks" / other autonomous categories show "All running" status

**Observed state:** Autonomous Security Level verified active 2026-08-18 via Cloudflare Security Overview. Detection tools panel shows autonomous categories running (see §2.7 inventory). No customer configuration required or possible.

**Screenshot:** `docs/security/screenshots/s13_detection_tools.png` (shared with §2.7)

---

### 2.5 TLS posture

**Target state:** modern TLS with automatic upgrades and strict origin validation.

| Setting | Target | Path |
|---|---|---|
| SSL/TLS encryption mode | Full (strict) | SSL/TLS → Overview |
| Always Use HTTPS | ON | SSL/TLS → Edge Certificates |
| Minimum TLS Version | 1.2 | SSL/TLS → Edge Certificates |
| TLS 1.3 | ON | SSL/TLS → Edge Certificates |
| Automatic HTTPS Rewrites | ON | SSL/TLS → Edge Certificates |
| Opportunistic Encryption | ON | SSL/TLS → Edge Certificates |

**Rationale:** modern TLS baseline; closes downgrade attacks (BEAST, POODLE class attacks against TLS 1.0/1.1). Full (strict) mode enforces TLS end-to-end between Cloudflare and origin AND validates the origin certificate is legitimate (not just present).

**Observed state:** TLS posture verified and hardened Session 35d (2026-08-17). Drift caught and closed:

- **SSL/TLS encryption mode:** was `Full`, changed to `Full (strict)` — now validates origin cert legitimacy (not just presence). Cloudflare Pages origin has properly-issued cert so no risk of change breaking traffic.
- **Always Use HTTPS:** was OFF, changed to ON — closed silent-HTTP-serving vulnerability for first-time visitors. HSTS in `frontend/_headers` (S-01) continues to protect repeat visitors, but first-time users typing `http://` or arriving from legacy HTTP links now get automatic redirect to HTTPS rather than an unencrypted response.
- **Minimum TLS Version:** was 1.0 (Cloudflare default), changed to 1.2 — removes TLS 1.0/1.1 downgrade attack surface. RFC 8996 deprecated TLS 1.0/1.1 in 2021; PCI-DSS 3.2 requires TLS 1.2 minimum. TLS 1.2 covers essentially all clients from the last decade.
- **TLS 1.3:** ON (Cloudflare default, no change needed)
- **Automatic HTTPS Rewrites:** ON (Cloudflare default, no change needed)
- **Opportunistic Encryption:** ON (Cloudflare default, no change needed)

**External audit via SSL Labs 2026-08-17:** Grade **A+** on all four Cloudflare edge endpoints tested (two IPv4, two IPv6). Certificate, Protocol Support, Key Exchange, and Cipher Strength all scored maximum. The "+" specifically rewards HSTS with `preload` directive shipped via `frontend/_headers` (S-01). Config verified consistently applied across Cloudflare's anycast edge.

**Screenshots:**
- `docs/security/screenshots/s13_tls_overview.png` — SSL/TLS Overview showing Full (strict) mode
- `docs/security/screenshots/s13_tls_edge_1.png` — Edge Certificates page (part 1 of 3)
- `docs/security/screenshots/s13_tls_edge_2.png` — Edge Certificates page (part 2 of 3)
- `docs/security/screenshots/s13_tls_edge_3.png` — Edge Certificates page (part 3 of 3)
- `docs/security/screenshots/s13_tls_ssllabs.png` — SSL Labs external verification (A+ across four endpoints)

---

### 2.6 Cloudflare Notifications

**Target state:** email notifications for security-material events — a second alert channel independent of `alert-founder` EF.

**Configured notifications (four total):**

| Notification | Product | Purpose |
|---|---|---|
| HTTP DDoS Attack Alert | DDoS Protection | Alerts when Cloudflare's L7 DDoS defenses activate against tumafly.com |
| Universal SSL Alert | SSL/TLS | Notifies on Universal Certificate validation status changes, issuance events, renewal events |
| Cloudflare Abuse Report Alert | Abuse | Alerts when Cloudflare receives an abuse report about tumafly.com |
| New Insight detected (all classes) | Security insights | Meta-notification: emails whenever any new "security insight" is detected across 51 tracked classes (bots, dangling DNS, cert misconfigurations, API endpoints without auth, etc.). Configured with "Select All" for broad signal capture pre-launch; refine to curated subset post-launch once we have data on which are noisy vs signal. |

**Recipient:** `alerts@tumafly.com` (existing monitored inbox — Cloudflare Email Routing to founder mobile device)

**Scope:** tumafly.com

**Notifications considered and NOT configured (with rationale):**

- **Advanced Certificate Alert** — redundant with Universal SSL Alert (Cloudflare Pages uses Universal SSL, not Advanced Certificate Manager)
- **Client-side security New Malicious Script/URL Alerts** — redundant with New Insight detected (which covers Client-side security insights via meta-notification)
- **DNS record change notification** — not surfaced in free-tier Notifications catalog; audit-log alternative deferred (see §5.4)
- **Weekly Security Insights** — not surfaced in free-tier Notifications catalog; on-demand Security Overview dashboard provides equivalent

**How to configure:**
- Dashboard → account level (not per-domain) → Notifications → Add
- One notification per row in the table above

**Observed state:** Four notifications configured 2026-08-18 all delivering to `alerts@tumafly.com`. Passive verification via first triggered event or first weekly summary; the Cloudflare Abuse Report Alert and DDoS Attack Alert are lowest-frequency (weeks or longer between fires); New Insight detected is highest-frequency and provides ongoing verification.

**Screenshot:** `docs/security/screenshots/s13_notifications.png`

---

### 2.7 Autonomous detection tools inventory

**Purpose:** documents the autonomous protection categories Cloudflare runs on tumafly.com without customer configuration. These sit alongside the explicitly-configured controls (§2.3-§2.6) and represent Cloudflare's continuously-updated defenses.

**Cloudflare Security Overview → Detection tools panel** shows the running status of each category. Verified 2026-08-18:

| Category | Status | Notes |
|---|---|---|
| **Web app exploits** | All running (1) | Autonomous signature detection for SQLi, XSS, RCE, path traversal patterns |
| **DDoS attacks** | All running (2) | L3/L4/L7 autonomous DDoS protection — Cloudflare baseline |
| **API abuse** | All running (2) | Autonomous protection against API-layer abuse patterns |
| **Client-side abuse** | All running (1) | Autonomous JavaScript integrity + resource monitoring — Cloudflare's Page Shield equivalent |
| **Fraud protection** | All running (1) | Autonomous behavioral fraud detection |
| **Bot traffic** | 0/2 running (2) | Bot Fight Mode deferred per Session 35d (see §5.2); Block AI bots also deferred (see §5.3) |
| **Precursor** | 0/1 running (1) | Backlog investigation (see §5.4) — Cloudflare feature we haven't fully characterized |

**Rationale for including in this doc:** these protections directly satisfy portions of the KYC §1.8 claim about WAF-based protection at the edge, independent of the Pro-tier configurable rules (§2.1, §2.2). Auditors reviewing "what protects the site from web app exploits" see this table alongside deferred Pro items.

**Observed state:** 5 of 7 detection tool categories fully running as of 2026-08-18. Bot traffic categories (2 of 2) intentionally deferred with documented rationale. Precursor category (1) pending investigation.

**Screenshot:** `docs/security/screenshots/s13_detection_tools.png`

---

## 3. Verification

Run after all controls are in the observed-enabled state. Do NOT run rate-limit verification from your primary work machine (the IP will be throttled for the duration window).

### 3.1 Rate-limit verification

```bash
for i in $(seq 1 120); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    https://tumafly.com/
done | sort | uniq -c
```

Expected: mix of 200 for the first ~100 requests, then 429 or Block response for the remainder. Rate-limit window is 10 seconds, so this burst should complete inside the window and demonstrate the block.

### 3.2 Autonomous Security Level verification

Passive check via dashboard:
- Dashboard → tumafly.com → Security → Security Overview
- Confirm Detection tools panel shows autonomous categories in "All running" status per §2.7 inventory

Cannot be actively probe-tested without an actual known-bad-reputation source IP. Post-launch traffic patterns will surface any blocks in Cloudflare Events log (Dashboard → Security → Events).

### 3.3 TLS posture verification

```bash
curl -sI https://tumafly.com/ 2>&1 | head -20
```

Verify `HTTP/2 200` response, `strict-transport-security` header present with `max-age=31536000; includeSubDomains; preload`.

External audit (comprehensive): https://www.ssllabs.com/ssltest/analyze.html?d=tumafly.com — target grade A or A+.

### 3.4 Cloudflare Notifications verification

Passive — first triggered event confirms delivery. To actively test the notification delivery pipeline (rare need), can trigger via `alert-founder` EF invocation for `alerts@tumafly.com` — that verifies the inbox path, though not Cloudflare-side notification-generation itself.

### 3.5 Detection tools verification

Same as §3.2 — dashboard visual check via Security Overview → Detection tools panel.

---

## 4. Rollback

Each configured control is independently reversible from the dashboard:

- Rate limiting: delete the rule (immediate)
- TLS settings: revert individual toggles (immediate — but note this would reintroduce drift caught in §2.5)
- Notifications: delete individual notifications (immediate)

Autonomous protections (§2.4, §2.7) cannot be rolled back — they're Cloudflare-managed and always-on.

Deferred controls (§2.1 Managed Rules, §2.2 OWASP CRS) have no current state to roll back.

No git rollback needed — configuration is dashboard-state only. Doc file changes revert via `git revert` normally.

---

## 5. Deferred / considered rules (backlog)

### 5.1 Cloudflare Pro upgrade — TRA-gated

Unlocks: §2.1 Managed Rules + §2.2 OWASP CRS + 15 rate-limit rules (§2.3 headroom) + 20 custom rules + Managed Challenge action for rate limits.

**Cost:** $20/month or $240/year (annual discount ~2 months free).

**Trigger:** TRA business milestone clearance. Founder-set condition; not tied to a specific date.

**Post-upgrade migration checklist:**

1. Enable Managed Rules per §2.1
2. Enable OWASP CRS per §2.2 (Paranoia Level 1 default)
3. Reconfigure rate-limit rule per §2.3 post-upgrade migration task (rename + Threshold 100→300 + Period 10s→60s + Duration 10s→60s + Action Block→Managed Challenge)
4. Update all three §2.x Observed state blocks + re-screenshot
5. Commit: `docs(security): S-13 Pro upgrade — Managed Rules + OWASP CRS + rate-limit reconfigured`
6. Update Roadmap DocUpdate to mark Pro upgrade milestone complete
7. Log to Running Updates Log (Security Framework queue) since posture materially changes

### 5.2 Bot Fight Mode

Cloudflare's free-tier bot protection beyond Turnstile. Would catch general crawler noise beyond Turnstile's search+payment scope. Documented false-positive risk on older Android WebViews — defer until post-launch traffic data reveals whether it helps or hurts the East African audience.

**Revisit trigger:** 30 days of post-launch traffic + observed bot pressure in Cloudflare Events log.

### 5.3 AI crawler access strategy — post-September-15 review

Cloudflare's "Block AI bots" toggle deprecates on Sept 15, replaced by more granular AI crawler access controls. TumaFly current stance: allow AI crawlers (permissive) since AI-powered search referrals from ChatGPT/Claude/Perplexity are a legitimate customer-acquisition channel for travel booking.

**Revisit trigger:** Sept 15 UI change lands; re-evaluate granular controls against SEO/AI-referrer strategy at that point.

### 5.4 Precursor detection tool investigation

Cloudflare's Security Overview shows Precursor category as "0/1 running (1)." Feature not fully characterized by Session 35d team. Investigation needed to determine what it does + whether it's worth enabling.

**Assumed low priority** — if it were critical, Cloudflare would surface it more prominently. But worth investigating during any post-launch security review or in Framework doc drafting for completeness.

### 5.5 DNS record change notification (audit log alternative)

DNS change notification not surfaced as a standalone notification in free-tier Notifications catalog. Alternative: enable Cloudflare's Audit Log emails from Account settings — those cover DNS record changes plus other account-level modifications.

**Interim compensating control:** all DNS changes going through SOP §6 procedure means every change lands in git via `docs/security/dns_config.md` update — provides after-the-fact audit trail even without real-time alert.

**Revisit trigger:** first team member added (audit log per-user tracking becomes valuable) OR any suspected account compromise.

---

## 6. Change management

See SOP Master §6 — Configuration Change Management.

Session 35d discovered Cloudflare's default TLS posture (Min TLS 1.0, Always Use HTTPS off) had drifted from a security-conscious deployment baseline. SOP §6 encodes an annual configuration review (first week of Q1) to catch upstream default changes going forward. See SOP §6.4.

---

## 7. Deployment record

**Configured:**

- TLS posture (drift caught + hardened): 2026-08-17
- Rate limit rule (free-tier shape, Pro migration deferred): 2026-08-18
- Autonomous Security Level (verified): 2026-08-18
- Cloudflare Notifications (4 configured): 2026-08-18
- Detection Tools inventory (verified): 2026-08-18
- Managed Rules (§2.1): DEFERRED until Cloudflare Pro (TRA-gated per §5.1)
- OWASP CRS (§2.2): DEFERRED until Cloudflare Pro (TRA-gated per §5.1)

**Configured by:** Founder (Bev)
**Session:** 35d

---

*End of S-13 Cloudflare WAF configuration. First landed Session 35d (2026-08-15).*