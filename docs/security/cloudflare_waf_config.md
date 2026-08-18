# TumaFly Cloudflare WAF Configuration

**Domain:** tumafly.com (Cloudflare Pages)
**Owner:** Founder (Bev)
**KYC alignment:** closes gap 1.8 (Cloudflare WAF configured + documented at edge)
**Introduced:** Session 35d (2026-08-15)
**Cloudflare plan:** Free tier

---

## 1. Purpose + scope

Source-of-truth attestation for the Cloudflare edge-security configuration protecting `tumafly.com`'s frontend surface. Referenced by KYC §1.8 and the Security Framework doc's technical-controls section.

**In scope:** Managed Rules, Rate Limiting on frontend, custom firewall rules on frontend, TLS posture, Cloudflare Notifications.

**Out of scope:**
- Response headers (HSTS / CSP / X-Frame-Options / Referrer-Policy / Permissions-Policy) — ship via `frontend/_headers` (S-01).
- DNS-layer controls (CAA / DNSSEC / SPF / DKIM / DMARC) — see `docs/security/dns_config.md`.
- Edge Function surface protection — EFs are called direct-to-Supabase and are protected at Supabase edge + application layer (S-07 OTP throttle, S-11 guest-token threshold). Composed narrative lives in the Security Framework doc.

---

## 2. Configuration inventory

### 2.1 Managed Rules — Cloudflare Managed Ruleset

**Target state:** enabled; action at Cloudflare defaults (Managed Challenge for medium-risk, Block for high-risk).

**How to configure:**
- Dashboard → tumafly.com → Security → WAF → Managed rules
- Deploy "Cloudflare Managed Ruleset"
- Leave rule actions at ruleset defaults unless a specific rule causes false-positives during verification

**Observed state:** _[fill in: enabled Y/N; action override if any; deployment date]_

**Screenshot:** `docs/security/screenshots/s13_managed_rules.png`

---

### 2.2 OWASP Core Rule Set

**Target state:** deferred until Cloudflare Pro plan.

**Rationale:** not exposed on free plan. Pro ($20/mo) unlocks it. Not blocking pre-launch — Managed Rules §2.1 provides baseline coverage.

**Observed state:** Not enabled — free plan limitation. Revisit on Pro upgrade (backlog §5.1).

---

### 2.3 Rate Limiting — frontend surface

**Target state:** one rate-limit rule (free-tier ceiling) protecting the tumafly.com frontend from crawler and enumeration abuse.

**Configuration:**
- Rule name: `frontend-per-IP-300rpm`
- Expression: `(http.host eq "tumafly.com")`
- Requests: 300 per 1 minute per client IP
- Action: **Managed Challenge** preferred over Block. Fallback: Block with 1-minute duration if free tier does not expose challenge.
- Duration: 1 minute

**Rationale for 300 rpm:** normal browsing session with page assets (fonts, images, JS) resolves well under 100 requests over any 1-minute window. 300 rpm gives 3× headroom for legitimate use while catching scrapers or content-harvesting bots running several requests per second sustained.

**How to configure:**
- Dashboard → tumafly.com → Security → WAF → Rate limiting rules → Create rule

**Observed state:** _[fill in: rule name, threshold applied, action selected, deployed Y/N]_

**Screenshot:** `docs/security/screenshots/s13_rate_limit.png`

---

### 2.4 Threat-score firewall rule

**Target state:** block requests from IPs Cloudflare has scored above a moderate-suspicion threshold.

**Configuration:**
- Rule name: `block-high-threat-score`
- Expression: `(cf.threat_score gt 40)`
- Action: Block

**Rationale for threshold 40:** Cloudflare threat scores range 0–100; 40+ maps to "known bad reputation across the Cloudflare network." Tunable upward if post-launch Events log shows false-positives on legitimate traffic.

**How to configure:**
- Dashboard → tumafly.com → Security → WAF → Custom rules → Create rule

**Observed state:** _[fill in]_

**Screenshot:** `docs/security/screenshots/s13_threat_score.png`

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

**Rationale:** modern TLS baseline; closes downgrade attacks. Full (strict) mode enforces TLS end-to-end between Cloudflare and origin AND validates the origin certificate is legitimate (not just present).

**Observed state:** TLS posture verified and hardened Session 35d (2026-08-17). Drift caught and closed:

- **SSL/TLS encryption mode:** was `Full`, changed to `Full (strict)` — now validates origin cert legitimacy (not just presence). Cloudflare Pages origin has a properly issued cert so no risk of the change breaking traffic.
- **Always Use HTTPS:** was OFF, changed to ON — closed silent-HTTP-serving vulnerability for first-time visitors. HSTS in `frontend/_headers` (S-01) continues to protect repeat visitors, but first-time users typing `http://` or arriving from legacy HTTP links now get automatic redirect to HTTPS rather than an unencrypted response.
- **Minimum TLS Version:** was 1.0 (Cloudflare default), changed to 1.2 — removes TLS 1.0/1.1 downgrade attack surface (BEAST, POODLE class). RFC 8996 deprecated TLS 1.0/1.1 in 2021; PCI-DSS 3.2 requires TLS 1.2 minimum. TLS 1.2 covers essentially all clients from the last decade.
- **TLS 1.3:** ON (Cloudflare default, no change needed)
- **Automatic HTTPS Rewrites:** ON (Cloudflare default, no change needed)
- **Opportunistic Encryption:** ON (Cloudflare default, no change needed)

External audit via SSL Labs 2026-08-17: **Grade A+** on all four Cloudflare edge endpoints tested (two IPv4, two IPv6). Certificate, Protocol Support, Key Exchange, and Cipher Strength all scored maximum. Config verified consistently applied across Cloudflare's anycast edge.

**Screenshots:**
- `docs/security/screenshots/s13_tls_overview.png` — SSL/TLS Overview showing Full (strict) mode
- `docs/security/screenshots/s13_tls_edge_1.png` — Edge Certificates page (part 1 of 3)
- `docs/security/screenshots/s13_tls_edge_2.png` — Edge Certificates page (part 2 of 3)
- `docs/security/screenshots/s13_tls_edge_3.png` — Edge Certificates page (part 3 of 3)
- `docs/security/screenshots/s13_tls_ssllabs.png` — SSL Labs external verification result

---

### 2.6 Cloudflare Notifications

**Target state:** email notifications for security-material events — a second alert channel independent of `alert-founder`.

| Notification | Rationale |
|---|---|
| DDoS Attack Alerts (L7) | Alerts if Cloudflare's L7 DDoS defenses activate |
| Advanced Certificate Alerts | Warns on cert renewal failure |
| DNS Record Changes | Detects account compromise or accidental DNS edits |
| Weekly Security Insights (optional) | Traffic + attack summary; useful for cadence review |

**Recipient:** founder monitored inbox (same as `alerts@` forwarding).

**How to configure:**
- Dashboard → Notifications → Add
- One notification per row above

**Observed state:** _[fill in: which are enabled]_

**Screenshot:** `docs/security/screenshots/s13_notifications.png`

---

## 3. Verification

Run after all controls are in the observed-enabled state. Do NOT run rate-limit verification from your primary work machine (the IP will be throttled for the duration window).

### 3.1 Rate-limit verification

```bash
for i in $(seq 1 320); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    https://tumafly.com/
done | sort | uniq -c
```

Expected: mix of 200 for the first ~300 requests, then challenge interstitial (HTTP 403 with challenge HTML) or block for the remainder.

### 3.2 Managed Rules verification

SQLi canary payload — Managed Rules should catch this:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://tumafly.com/?id=1'%20OR%20'1'='1"
```

Expected: 403 or Managed Challenge (NOT 200 passthrough).

### 3.3 Threat-score rule verification

Cannot be actively tested without a known-bad-reputation source IP. Passive: check Dashboard → Security → Events after ~24h of live production traffic, filter by rule name `block-high-threat-score`. Non-zero blocks confirms the rule is live.

### 3.4 TLS posture verification

```bash
curl -sI https://tumafly.com/ 2>&1 | head -20
```

External audit (comprehensive): https://www.ssllabs.com/ssltest/analyze.html?d=tumafly.com — target grade A or A+.

### 3.5 Cloudflare Notifications verification

Passive — the first triggered event or the first weekly summary confirms delivery.

---

## 4. Rollback

Each control is independently reversible from the dashboard:
- Managed Rules: toggle OFF (immediate)
- Rate limiting: delete the rule (immediate)
- Threat-score rule: disable or delete (immediate)
- TLS settings: revert to previous values (immediate — but note this would reintroduce the drift caught in §2.5)
- Notifications: delete individual notifications (immediate)

No git rollback needed — configuration is dashboard-state only.

---

## 5. Deferred / considered rules (backlog)

### 5.1 OWASP Core Rule Set — Pro plan upgrade

Ship on any move to Cloudflare Pro. Would materially strengthen coverage beyond Managed Rules baseline. Blocked on cost decision, not on scope or design.

### 5.2 Bot Fight Mode

Cloudflare's free-tier bot protection. Would catch general crawler noise beyond Turnstile's search+payment scope. Documented false-positive risk on older Android WebViews — defer until post-launch traffic data reveals whether it helps or hurts the East African audience.

Revisit trigger: 30 days of post-launch traffic + observed bot pressure in Cloudflare Events log.

---

## 6. Change management

See SOP Master §6 — Configuration Change Management.

Session 35d discovered that Cloudflare's default TLS posture (Min TLS 1.0, Always Use HTTPS off) is looser than a security-conscious deployment requires. SOP §6 will encode a periodic Cloudflare-defaults review to catch upstream default changes.

---

## 7. Deployment record

**Configured:**
- TLS posture (drift caught + hardened): 2026-08-17

**Configured by:** Founder (Bev)
**Session:** 35d

---

*End of S-13 Cloudflare WAF configuration. First landed Session 35d (2026-08-15).*