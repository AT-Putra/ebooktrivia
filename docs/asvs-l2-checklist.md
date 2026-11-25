# OWASP ASVS 5.0.0, Level 2: verification checklist (US-031, plan M11.1)

- **Standard:** OWASP ASVS **5.0.0** (the latest release, 2025-05-30; `OWASP/ASVS` release `v5.0.0_release`, flat JSON
  export). Every Level 1 and Level 2 requirement is listed: **253** (70 L1, 183 L2). Level 3 is out of scope.
- **Scope:** apps/public (play., order., api. and the SDK), apps/admin (admin.), apps/worker and the internal process, the
  PostgreSQL roles and SECURITY DEFINER functions (packages/db/sql), Valkey, Caddy (infra/caddy/Caddyfile), the LP domains,
  and the VM provisioning (infra/provision, infra/quadlet).
- **State:** worktree of US-031 rebased on main b97f57d (US-030 and US-033 merged), 2026-11-22. Line numbers are of that tree with
  the US-031 changes.
- **Method:** each row cites the code (`path:line`), the test that proves it (`file > "title"`), and a runbook section.
  Nothing is Met without evidence that was opened and checked; where only part of a requirement holds, the row says
  which part is missing, the risk, and a follow-up.
- **Statuses:** **Met**; **Partial** (some of it holds: the gap, the risk and a follow-up are given); **Not met** (the
  control does not exist: the risk and a follow-up are given); **N/A** (with the reason); **Staging-pending** (built and
  checked locally; the evidence needs the staging VM, docs/runbooks/security-scans.md).

## Summary

| Chapter | Total | Met | Partial | Not met | N/A | Staging-pending |
|---|---|---|---|---|---|---|
| V1 Encoding and Sanitization | 27 | 17 | 2 | 0 | 8 | 0 |
| V2 Validation and Business Logic | 11 | 11 | 0 | 0 | 0 | 0 |
| V3 Web Frontend Security | 19 | 17 | 2 | 0 | 0 | 0 |
| V4 API and Web Service | 10 | 2 | 2 | 0 | 6 | 0 |
| V5 File Handling | 9 | 8 | 0 | 1 | 0 | 0 |
| V6 Authentication | 35 | 26 | 5 | 0 | 4 | 0 |
| V7 Session Management | 18 | 13 | 3 | 0 | 2 | 0 |
| V8 Authorization | 7 | 5 | 1 | 0 | 1 | 0 |
| V9 Self-contained Tokens | 7 | 7 | 0 | 0 | 0 | 0 |
| V10 OAuth and OIDC | 29 | 0 | 0 | 0 | 29 | 0 |
| V11 Cryptography | 14 | 9 | 4 | 0 | 1 | 0 |
| V12 Secure Communication | 9 | 2 | 1 | 1 | 2 | 3 |
| V13 Configuration | 13 | 7 | 6 | 0 | 0 | 0 |
| V14 Data Protection | 9 | 3 | 6 | 0 | 0 | 0 |
| V15 Secure Coding and Architecture | 13 | 9 | 4 | 0 | 0 | 0 |
| V16 Security Logging and Error Handling | 16 | 8 | 7 | 1 | 0 | 0 |
| V17 WebRTC | 7 | 0 | 0 | 0 | 7 | 0 |
| **Total** | **253** | **144** | **43** | **3** | **60** | **3** |

The story's other criteria: **ZAP baseline and authenticated scans on staging: Staging-pending** (scripts, plans and
rules built; local baseline dry run 2026-11-22: 0 High, 0 FAIL-rule alerts; the real finding it showed, pages without a
script policy, is fixed). **OSV-Scanner and gitleaks: clean** (gitleaks 8.30.1 over all 43 commits of every branch and the
working tree; OSV-Scanner 2.7.0: one advisory (GitHub severity moderate) fixed by a scoped override, two dev-only Mediums overridden by package name and version until 2027-02-22).
**Security headers per host: verified** by `infra/verify/local/security-headers.sh` (23 responses, all pass; CI job
`edge-smoke`); the same script runs against staging with `--staging`. docs/runbooks/security-scans.md has all of it.

### Not met (each an accepted risk or a deferral), and the largest Partials (risk, follow-up)

| ID | What is missing | Risk | Follow-up |
|---|---|---|---|
| V5.4.3 | No antivirus scan of uploaded PDFs, proofs or LP assets | Low | **Accepted risk (Owner decision, 2026-11-22):** only the Owner and Staff upload, signed in with forced TOTP behind the IP allowlist; every file is type-checked (extension and magic bytes) and sanitized (SVG and ZIP checks), and served as an attachment or from an LP origin; the Owner scans files locally before uploading them |
| V12.3.3 (V12.3.1) | Plaintext between Caddy, the apps, PostgreSQL and Valkey | Low on one VM: the hops never leave podman networks marked Internal=true with pinned addresses; an attacker on the host already has the keys | **Accepted risk (single VM, internal networks).** Revisit before any multi-host move (pg `hostssl`, Valkey `tls-port`) |
| V16.4.3 | Logs stay on the VM (journald); nothing ships them off-host | Medium: a compromised host can erase its trail (the reveal watch's RAISE LOG line included) | **Decided in US-015, staging-pending** (`docs/decisions/off-host-logs.md`): `systemd-journal-upload` to `systemd-journal-remote` on the monitoring box (both part of systemd, no new tool), mutual TLS; go-live GL-20. The log monitors of security-scans.md section 5 are still to be wired |
| V14.1.2, V14.2.4 (Partial) | The PII inventory classifies every column and documents its erasure; no single per-level requirement set (encryption at rest, caching, logging); no database encryption at rest | Medium under UU PDP | Add the per-level requirements to docs/compliance/pii-inventory.md; disk encryption with the next VM rebuild (plan M4) |
| V6.3.3 | Players log in with one factor (WhatsApp OTP or a magic link) | Low: a player account holds game state only (no payment, masked data) | Accepted (product decision); documented in the appendix |
| V13.2.4 / V13.2.5 | No outbound destination allowlist (the egress guard drops metadata and local addresses only). **US-015 adds one more egressing container: PostgreSQL, on `ebt-backup`, for wal-g** (the storage endpoint cannot be pinned) | Medium: a compromised worker can reach any public host; **accepted risk: PostgreSQL can too**, which only a PostgreSQL superuser exploit could use, since no application login is a superuser or holds `pg_execute_server_program` / `pg_read_server_files` / `pg_write_server_files` (`roles.int.test.ts`, `host-check.sh`; `docs/runbooks/backups.md`) | Per-destination egress allowlist (nftables sets of Midtrans, WAHA, SMTP, the conversion APIs and the backup storage's published ranges), after v1 |
| V13.3.1 | No secrets manager: private keys in root-owned 0640 env files | Medium: host compromise exposes them | Accepted for v1 (escrowed keys, plan M4); a KMS later |
| V8.2.3 | Owner and Staff share the one `admin_rw` login: the Staff field rules are app-layer only | Medium if the console process is compromised | Accepted (one console process); the policy matrix test pins the app rules |

## V1 Encoding and Sanitization

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V1.1.1 | 2 | Met | Bodies are decoded once, as fatal UTF-8 JSON, then validated (`apps/public/src/lib/http.ts:106-116`, `checkout/request.ts:30-58`); paths are decoded only to refuse internal routes, never to serve them (`apps/public/src/lib/order/routing.ts` decodedPath / isNextDataPath). Tests: `request.test.ts > "maps invisible fillers to spaces and refuses lone surrogates, private-use and unassigned code points in a name (P2-C)"`; `proxy.test.ts > "answers Next's data route with a bare 404 on every host, so it cannot reach the pages behind it (security N1)"` | |
| V1.1.2 | 2 | Met | Escaping at the sink: React text nodes; `packages/core/src/template.ts:205-207` escapeHtml at render time; SQL parameters bound by postgres.js | |
| V1.2.1 | 1 | Met | No `dangerouslySetInnerHTML` anywhere (only comments, `apps/public/src/components/legal/legal-document.tsx:1-4`); e-mail preview in `<iframe sandbox="">` (`apps/admin/src/app/(console)/settings/templates/template-editor.tsx:68`). Tests: `legal-document.test.ts > "escapes %s in the body and the title: no element, attribute or URL from it reaches the markup"`; `template.test.ts > "escapes the five characters that matter in HTML text and in a quoted attribute, and nothing else"`; `e2e/tests/admin-settings.spec.ts > "a template test-send enqueues a worker job; the preview escapes user content"` | No lint rule bans the HTML sinks in the apps (only `packages/sdk/src/build.test.ts:101-102` for the SDK) |
| V1.2.2 | 1 | Met | `packages/sdk/src/redirect.ts:25-39`; `packages/core/src/magic-link-url.ts:29-35`; `template.ts:27-37`; `packages/adapters/src/signed-url.ts:44-45`; `safe-fetch.ts:244-247` (https only). Tests: `redirect.test.ts > "navigates to the parsed form, never the raw string (case and tabs are normalised, a backslash never leaves the host)"`; `template.test.ts > "refuses variables in the scheme or host"` | |
| V1.2.3 | 1 | Met | JSON via `JSON.stringify` with `application/json; charset=utf-8` and nosniff (`http.ts:14-18, 44-49`); SDK writes `textContent` (`packages/sdk/src/form.ts:17`) | |
| V1.2.4 | 1 | Met | postgres.js tagged templates throughout; `.unsafe` only with constants (`apps/admin/src/lib/settings/contest.ts:327-328`, `rescore.ts:77-78`, `apps/worker/src/rollups.ts:21`, `sweepers.ts:339-340`, `packages/db/src/migrate.ts:45-53`); DEFINER SQL uses `format(%I/%L)` (`infra/provision/db-roles.sh:117-132`) | No lint rule forbids an interpolated `.unsafe(` |
| V1.2.5 | 1 | Met | No `child_process` in apps/*/src or packages/*/src (grep); only dev tooling `tools/assets/src/key.ts:1` with fixed arguments | |
| V1.2.6 | 2 | N/A | No LDAP | |
| V1.2.7 | 2 | N/A | No XPath (the only hit is a variable name) | |
| V1.2.8 | 2 | N/A | No LaTeX | |
| V1.2.9 | 2 | Met | Every `new RegExp` is built from constants (`packages/uploads/src/lp-html.ts:21, 47-50`; `template.ts:237, 268-270`; `packages/adapters/src/captcha.ts:125-126`); no user input reaches a RegExp | Holds by construction, no test |
| V1.3.1 | 1 | Partial | LP HTML is the author's static page, isolated on its own origin with a CSP (`infra/caddy/Caddyfile:393-451`, page CSP :439); e-mail template HTML: variables only in text, scanned (`template.ts:209-233, 273-276`). Tests: `template-html.test.ts > "property: fragments of tags, quotes, comments and raw text never leak a marker"`; `template.test.ts > "item 7: email_html refuses variables in attribute values, except {link_trivia} as a whole quoted href"` | The STATIC HTML of an e-mail template (Owner/Staff-authored) is checked by a denylist, not sanitized: on* attributes and `javascript:` hrefs are not refused. Risk Low (staff-authored, mail clients strip scripts). Follow-up: an allowlist sanitizer for template HTML |
| V1.3.2 | 1 | Met | No eval / `new Function` / vm in source; no `'unsafe-eval'` in production CSPs (`apps/admin/src/lib/http-security.ts:33-47`, `apps/public/src/lib/order/csp.ts`). Tests: `packages/sdk/src/build.test.ts > "contains no eval, Function constructor, document.write or HTML-string sinks"`; `http-security.test.ts > "allows scripts only by nonce, with no unsafe-inline or unsafe-eval in production"`; `e2e/tests/sdk.spec.ts > "runs no server-supplied code: no iframe, the isolation flags on"` | `'wasm-unsafe-eval'` only for the Cap solver |
| V1.3.3 | 2 | Met | Dangerous contexts get allowlisted, length-capped values: SMTP recipient, display name and attachment name (`packages/adapters/src/smtp.ts:99-121`), LP ZIP names (`packages/uploads/src/lp-zip.ts:13-20`), phone E.164 (`request.ts`). Tests: `smtp.test.ts > "refuses unsafe attachment filenames and content types"`; `lp-zip.test.ts > "refuses hidden, overlong, non-NFC, bidi-spoofed and URL-hostile names"` | |
| V1.3.4 | 2 | Met | SVG allowlist (`packages/uploads/src/svg.ts:1-27, 52-67, 75-86, 99-120, 243-246`) and an SVG sandbox CSP (`Caddyfile:437`). Tests: `svg.test.ts` "svgProblem: refused" table; `lp-zip.test.ts > "refuses an unsafe SVG and says why"`; `policy.test.ts > "is rejected everywhere outside an LP ZIP, by content, extension or MIME type"` | |
| V1.3.5 | 2 | Met | Fixed variable set, single pass, fail closed, no template engine (`template.ts:1-43, 45, 58, 116`); legal pages are plain-text blocks. Tests: `template.test.ts > "fails closed on unknown variables and secrets"`; `template-html.test.ts > "keeps variables out of <style> while allowing CSS braces there"` | |
| V1.3.6 | 2 | Met | `packages/adapters/src/safe-fetch.ts:1-36, 93-120` (connect-time address check), 266-269 (no redirects); audited WAHA private-IP allowlist (`apps/worker/src/delivery/access.ts:52`); SMTP uses the same policy (`smtp.ts:123-136`). Tests: `safe-fetch.test.ts > "refuses a public-looking name that resolves to a private or loopback address (rebinding)"`, `> "never follows a redirect"`; `infra/verify/src/networks.test.ts > "%s Subnet=%s is refused end to end, even for an allowlisted private host"` | |
| V1.3.7 | 2 | Met | As V1.3.5: templates are never built from untrusted input; values fill a fixed set. Test: `template.test.ts > "item 8: rejects leftover brace tokens instead of silently dropping a value"` | |
| V1.3.8 | 2 | N/A | No JNDI (Node.js) | |
| V1.3.9 | 2 | Met | The cache is Valkey: keys are built from hashes and canonical buckets only (`apps/public/src/lib/valkey.ts` phoneKey, the Cap nonce pattern), values are constants; the public ACL user can only FCALL the worker-loaded function (US-031). Test: `apps/public/test/valkey-functions.int.test.ts > "is loaded by the worker user, FCALLed by public, and public can run no Lua of its own"` | |
| V1.3.10 | 2 | N/A | No printf-style formatting of untrusted data (JSON logs with allowlisted fields) | |
| V1.3.11 | 2 | Met | `smtp.ts:11-15, 99-121, 170-171, 177-186` (one plain recipient, no file/URL access); subject without CR/LF (`template.ts:26`). Tests: `smtp.test.ts > "refuses the recipient %j before connecting"` (the `\r\nBcc:` case); `template.test.ts > "never lets CR/LF into an email subject"` | |
| V1.4.1 | 2 | N/A | Managed runtime (TypeScript on Node.js); no unmanaged code of our own (native libraries are vendor builds: sharp, argon2) | |
| V1.4.2 | 2 | N/A | As V1.4.1; amounts are integers checked by DB CHECKs (`orders.int.test.ts > "rejects amount_idr = %i (ET041)"`) | |
| V1.4.3 | 2 | N/A | As V1.4.1 (garbage-collected) | |
| V1.5.1 | 1 | Partial | SVG: a custom tokenizer refuses an internal DTD subset (`svg.ts:24-27, 246`; test `svg.test.ts` refused case "internal DTD subset (entities)"). XLSX: rewritten canonically (`packages/uploads/src/zip.ts:299`), then parsed by exceljs 4.4.0 (saxes, no external entities) | No test feeds an XXE / billion-laughs sheet through exceljs; reliance on the parser default is undocumented. Follow-up: one int test with an entity-bearing sheet |
| V1.5.2 | 2 | Met | JSON only, on capped bytes, then zod or fixed keys (`http.ts:21, 106-116`; `apps/public/src/lib/webhooks/waha.ts:90`; `request.ts:30-58`). Tests: `request.test.ts > "refuses another wire version or a body that is not an object, without fields"`; `webhook.int.test.ts > "400 for a non-JSON, oversized or incomplete body"` | |

## V2 Validation and Business Logic

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V2.1.1 | 1 | Met | `packages/core/src/sdk-contract.ts:1-21, 41, 92-121` (SDK_PATTERNS, SDK_LIMITS); `apps/admin/src/lib/settings/limits.ts:1-30`; `trivia-import.ts:1-31`; runbooks `landing-pages.md "## What a ZIP may hold"`, `staging-provision.md "### Operator steps"` | |
| V2.1.2 | 2 | Met | Cross-field rules are written where they are enforced: `packages/db/sql/triggers.sql:248-299` (landing page, program, product and price belong together; sales window; expiry) | |
| V2.1.3 | 2 | Met | Per-user and global limits: `limits.ts:1-30` (bounds shared with a DB CHECK), `functions.sql:153-177` (per-phone cap, global OTP breaker); runbook `staging-provision.md "### Operator steps"` | |
| V2.2.1 | 1 | Met | `request.ts:28-58, 129-189`; DB CHECKs (`packages/db/src/schema/funnel.ts:238-249`). Test: `checkout.int.test.ts > "applies SDK_LIMITS to every field and answers the contract's field codes together"` | |
| V2.2.2 | 1 | Met | Server-side validation on every route (zod, DB CHECKs, triggers); the SDK's checks are a convenience. Test: `orders.int.test.ts > "rejects amount_idr = %i (ET041)"` | |
| V2.2.3 | 2 | Met | `triggers.sql:248-299, 316-327`. Tests: `orders.int.test.ts > "rejects a landing page that belongs to another program (ET042)"`, `> "files an attempt only under its own order's Midtrans id, {public_id}-{n} (ET049)"` | |
| V2.3.1 | 1 | Met | Order status machine guard (`triggers.sql:216-246`); trivia flow: serve, answer once, settle, reveal (`packages/db/sql/play.sql`). Tests: `packages/core/src/order-machine.test.ts > "5 replays of a settlement give exactly one transition"`; `play-flow.int.test.ts > "refuses an answer to a question not served yet (ET145), and a refunded player (ET141)"` | |
| V2.3.2 | 2 | Met | Limits enforced as documented (V2.1.3), plus the trivia rules: one attempt per set (`play.sql:414-420`), 1500 ms grace (`triggers.sql:651-652`). Test: `play-flow.int.test.ts > "accepts a pick inside the latency grace (deadline + 1500 ms) charged at most the timer; refuses one after it (ET109)"` | |
| V2.3.3 | 2 | Met | Inbox insert and outbox enqueue in one transaction (`apps/public/src/lib/webhooks/midtrans.ts:16-18, 106, 116`); settlement under `FOR UPDATE` with a conditional UPDATE (`apps/worker/src/payments.ts:271, 291, 319-322`). Tests: `webhook.int.test.ts > "five identical notifications at once still make one inbox row and one outbox row"`; `payments.int.test.ts > "two workers processing the same order's notifications at once still give exactly one PAID effect"` | |
| V2.3.4 | 2 | Met | Checkout advisory lock and FOR UPDATE (`apps/public/src/lib/checkout/orders.ts:4-6, 119, 133`); contest lock (`functions.sql:359-395`); one answer per question (`play.sql:562-578`). Tests: `checkout.int.test.ts > "creates ONE order for simultaneous submits of the same phone + landing page; the others get its URL as deduped"`; `play-flow.int.test.ts > "answers once: of two concurrent answers exactly one is recorded (the other ET144); the answer says nothing, the reveal of the committed pick does"`; `play.int.test.ts > "waits for an exclusive contest lock (a snapshot, a re-score, an extension) before it writes"` | |
| V2.4.1 | 2 | Met | Per IP (/64 and /48), per phone, global OTP breaker, Cap proof of work, per-URL file cap (`packages/edge/src/client-ip.ts:127-144`; `checkout/handler.ts:110, 159-161`; `functions.sql:153-177`; `captcha.ts:200-301`; `files.ts:27, 81-87`). Tests: `checkout.int.test.ts > "limits checkouts per client IP (an IPv6 /64), with Retry-After"`; `play-auth.int.test.ts > "the global send breaker: the same answer, nothing stored or sent, one persisted critical alert"`; `cap.int.test.ts > "limit an IPv6 /48 on top of its /64s (P2-4)"`. Anti-cheat flags: `apps/admin/src/lib/settings/contest.ts:14, 43-48`; `contest.int.test.ts > "flags fast medians, identical on-time answer times on a set, and more than 3 players per IP or browser; nothing else, most flags first"`. US-031 the reveal watch (`play.sql:660-704`): a reveal more than 60 s after the answer is refused with no content, flagged, and 3+ distinct flagged attempts an hour raise `play_reveal_misuse`; tests `play-flow.int.test.ts > "refuses a reveal more than 60 s after the answer (nothing of it goes out), counts and flags it"`, `> "raises ONE open play_reveal_misuse alert once 3 distinct attempts are flagged within an hour, with ids and counts only"` | The checkout's per-IP limit is /64 only (the per-LP cap and the proof of work offset it) |

## V3 Web Frontend Security

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V3.2.1 | 1 | Met | API JSON with nosniff (`http.ts:14-18, 44-48`); signed files: `attachment`, CSP `sandbox`, nosniff, no-store, api host only (`apps/public/src/lib/files.ts:51-56, 64-65, 110`); LP fixed Content-Type map (`Caddyfile:414-434`), SVG sandbox (:437). Tests: `files.int.test.ts > "serves the PDF to a valid signed URL, as an attachment that is never rendered on our origin"`; `caddyfile.test.ts > "sets each extension's fixed Content-Type from the same table the upload checks against"` | |
| V3.2.2 | 1 | Met | React text nodes; no HTML sinks in the apps (grep). Test: `legal-document.test.ts > "escapes %s in the body and the title: no element, attribute or URL from it reaches the markup"` | No lint rule bans `dangerouslySetInnerHTML` |
| V3.3.1 | 1 | Met | Every cookie is `__Host-` + Secure: admin (`apps/admin/src/lib/auth/instance.ts:31-40, 185-187`), player (`apps/public/src/lib/play/auth.ts:42-56, 265-268`); no cookie at all on order/api/SDK/LP (Caddy strips them on order, `Caddyfile:266-289`). Tests: `auth-flow.int.test.ts > "creates a password-only session that may only enroll, with __Host- SameSite=Strict cookies"`; `play-auth.int.test.ts > "logs in with the code: __Host-play_session (Secure, HttpOnly, SameSite=Lax, Path=/, 30 days, no Domain); single use"`; `infra/verify/src/security-headers.test.ts > "allows cookies only on admin and play, and only __Host-, Secure, HttpOnly, SameSite, Path=/, no Domain"` | |
| V3.3.2 | 2 | Met | Admin SameSite=Strict (`instance.ts:186`); player Lax for links from WhatsApp / e-mail, with exact-Origin checks on every mutation (`auth.ts:19-20`) | |
| V3.3.3 | 2 | Met | As V3.3.1 (`__Host-` names, no Domain, Path=/) | |
| V3.3.4 | 2 | Met | Session cookies HttpOnly (`instance.ts:185-187`, `auth.ts:50-56`); tokens only via Set-Cookie | |
| V3.4.1 | 1 | Met | `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every app host response (`Caddyfile:121-131`), `max-age=31536000` on LP domains (customers' domains, :375). Tests: `security-headers.test.ts > "fails each edge header that is missing, doubled or weakened"`; real responses: `infra/verify/local/security-headers.sh` (CI `edge-smoke`). Preload decision: `security-scans.md "## 2. Security headers per host"` | Over TLS on staging: `security-headers.sh --staging` |
| V3.4.2 | 1 | Met | The Origin is reflected only when it equals a registered LP origin, never `*`, never credentials (`http.ts:1-9, 32-42`); `*` only on the public SDK files (`Caddyfile:346-366`). Tests: `http.test.ts > "maps every error code to the contract's status; an origin refusal has no CORS header"`; `security-headers.test.ts > "fails each edge header that is missing, doubled or weakened"` (no `*` outside the SDK, never credentials) | |
| V3.4.3 | 2 | Partial | Nonce CSPs on every app page, no `'unsafe-inline'`/`'unsafe-eval'` scripts (`http-security.ts:33-47`; `csp.ts`; US-031 `apps/public/src/proxy.ts:115-123` defaultPage for every unrouted page); the edge adds the global `frame-ancestors 'none'; object-src 'none'; base-uri 'none'` to every app-host response (`Caddyfile:127`). Tests: `security-headers.test.ts > "requires the edge's global CSP (frame-ancestors, object-src, base-uri 'none') on every response of our hosts, not on LP domains"`; `proxy.test.ts > "gives every other page (the api origin's /, robots.txt, any 404) the strict nonce CSP and the play headers"`; `e2e/tests/admin-auth.spec.ts > "nonce CSP: every script carries the per-request nonce, no violations, no unsafe-inline scripts"` | LP domains run the author's static HTML: inline scripts allowed and `base-uri 'self'` (the documented US-023 default, docs/runbooks/landing-pages.md). Risk accepted: separate origins with no cookies or app data |
| V3.4.4 | 2 | Met | nosniff on every response (`Caddyfile:125`, :402). Test: `security-headers.test.ts > "fails each edge header that is missing, doubled or weakened"` | |
| V3.4.5 | 2 | Met | One strict Referrer-Policy per response: FORCED `strict-origin` on order.<domain> (AC-T5: whatever the app sends; `Caddyfile:139-144`), elsewhere the route's own (`no-referrer` play, `same-origin` admin) else the edge default (`Caddyfile:146-151`, US-031). Tests: `caddyfile.test.ts > "emits exactly ONE Referrer-Policy per app site: FORCED strict-origin on order.<domain> (AC-T5); elsewhere the app's own, else strict-origin-when-cross-origin"`; `order-headers.sh` (the stand-in upstream sends `unsafe-url`, the browser gets `strict-origin`); `security-headers.sh` PROBE_REFERRER probes | |
| V3.4.6 | 2 | Partial | `frame-ancestors 'none'` on every app-host response (`Caddyfile:127`); LP pages `frame-ancestors 'self'` (:439). Test: as V3.4.3 | LP non-page files (CSS, images) and LP 404s carry no frame-ancestors. Risk Low (not documents). Follow-up: add `frame-ancestors 'self'` to the LP header block |
| V3.5.1 | 1 | Met | Admin: every non-GET needs Origin == ADMIN_ORIGIN, also in the action / route wrappers (`apps/admin/src/proxy.ts:26-31`, `http-security.ts:22-25`, `lib/next/actions.ts:35-42`, `route.ts:40-43`); play: exact Origin first in every mutation (`apps/public/src/lib/play/handlers.ts`). Tests: `e2e/tests/admin-auth.spec.ts > "cross-origin POSTs to server actions and route handlers are refused (403), the same request from the admin origin works"`; `play/guards.test.ts > "every state-changing play handler checks the exact Origin before anything else"` | |
| V3.5.2 | 1 | Met | The LP API requires `application/json` (preflighted) and an allowlisted Origin (`http.ts:106-108`) | |
| V3.5.3 | 1 | Met | State changes are POST only. Test: `apps/admin/src/app/guards.test.ts > "never offer state changes on GET (mutations are POST-only route handlers or server actions)"` | `GET /api/v1/play/auth/session` may rotate a due session (maintenance, not a user action) |
| V3.5.4 | 2 | Met | admin., play., order., api. and the LP domains are separate sites (`Caddyfile:225, 250, 266, 291, 393`), host-gated in the app (`apps/public/src/lib/order/routing.ts`). Tests: `caddyfile.test.ts > "has host blocks for admin, play, order and api, then the LP catch-all"`; `proxy.test.ts > "answers the legal and order routes with a bare 404"` | |
| V3.5.5 | 2 | Met | No `message` listener in our code (grep); the vendored Cap widget checks `ev.source` (`packages/sdk/node_modules/@cap.js/widget/src/cap.js:208-209`), isolation on (`packages/sdk/src/cap.ts:79`). Test: `cap.test.ts > "never runs instrumentation a server would send: the isolation flag is on and the inflater fallback is an empty data: URL (security review S3)"` | |
| V3.7.1 | 2 | Met | No plugins; `object-src 'none'` everywhere (`csp.ts`; `Caddyfile:127, 439`) | |
| V3.7.2 | 2 | Met | SDK navigation guard (`redirect.ts:18-39`); Snap `redirect_url` pinned (`packages/adapters/src/midtrans.ts:299-313`); admin redirects only to its own paths (`apps/admin/src/lib/access.ts:24`). Tests: `redirect.test.ts > "refuses the other environment's host"`; `midtrans.test.ts > "pins the Snap redirect_url to the Snap host"` | |

## V4 API and Web Service

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V4.1.1 | 1 | Partial | charset on the API (`http.ts:47`), the edge (`packages/edge/src/edge-server.ts`), admin 403 (`apps/admin/src/proxy.ts:29`), LP text types (`Caddyfile:414-434`) | LP `image/svg+xml` and `application/json` carry no charset. Follow-up: add `; charset=utf-8` in the LP map |
| V4.1.2 | 2 | Met | Port 80 redirects browser hosts to HTTPS and answers api.<DOMAIN> 400 without a redirect, so a plaintext API or webhook call is told, never silently upgraded (`Caddyfile:210-223`, US-031). Tests: `caddyfile.test.ts > "only redirects to HTTPS on port 80, and answers api.<domain> 400 there instead of redirecting it (US-031, ASVS V4.1.2)"`; stack-sim and host-check `http://api. answers 400` | |
| V4.1.3 | 2 | Met | Caddy sets XFF to the TCP peer and strips client-address headers (`Caddyfile:155-164`); the edge believes XFF only from Caddy's pinned IP (`packages/edge/src/client-ip.ts:14-28, 57-97`). Tests: `client-ip.test.ts > "ignores X-Forwarded-For from any other peer"`; `edge-server.test.ts > "ignores every forwarding header from a peer that is not the proxy"`; runbook `staging-provision.md "## 5. Verify criterion 5 (real client address)"` | |
| V4.2.1 | 2 | Partial | Caddy is the only ingress and re-frames every request to the upstream; Node's default strict parser (no `insecureHTTPParser`, grep); h1/h2 only (`Caddyfile:39`) | No smuggling test. Follow-up: the optional ZAP active scan on staging, or a crafted CL/TE probe in stack-sim |
| V4.3.1 | 2 | N/A | No GraphQL | |
| V4.3.2 | 2 | N/A | No GraphQL | |
| V4.4.1 | 1 | N/A | No WebSocket (grep) | |
| V4.4.2 | 2 | N/A | No WebSocket | |
| V4.4.3 | 2 | N/A | No WebSocket | |
| V4.4.4 | 2 | N/A | No WebSocket | |

## V5 File Handling

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V5.1.1 | 2 | Met | `packages/uploads/src/policy.ts:1-30`; `lp-zip.ts:1-33, 54-63, 88-112`; `trivia-import.ts:16-31`; runbook `landing-pages.md "## What a ZIP may hold"` | |
| V5.2.1 | 1 | Met | Size caps before parsing (`policy.ts`, `lp-zip.ts:250`; Caddy `request_body` 110 MB admin). Tests: `policy.test.ts > "rejects over 5 MiB before decoding"`; `lp-zip.test.ts > "refuses an archive over 25 MiB before parsing it, and more than 500 files"`; `settings.int.test.ts > "refuses over the hard cap before anything is written"` | |
| V5.2.2 | 1 | Met | Extension and magic bytes must agree (`policy.ts:1-11`; `lp-zip.ts:25-27, 88-112`). Tests: `policy.test.ts > "rejects wrong magic, and an extension or MIME type that disagrees"`; `lp-zip.test.ts > "refuses content that does not match its extension (sniffed), and binary data in a text file"` | |
| V5.2.3 | 2 | Met | Measured while inflating, headers untrusted: 100:1, 150 MiB, 500 files, 25 MiB per file (`lp-zip.ts:21-24, 54-63`; `zip.ts`). Tests: `lp-zip.test.ts > "stops a zip bomb while inflating: 1 KiB of compressed zeros claiming 1 byte is refused on the ratio budget"`; `zip.test.ts > "stops a zip bomb at the budget, whatever the headers claim"` (US-031: injected small budgets) | |
| V5.3.1 | 1 | Met | LP files only through `file_server`, fixed types, `hide .*`, index.html only (`Caddyfile:393-451`); downloads as attachments (`files.ts:110`). Test: `caddyfile.test.ts > "runs file_server only: no directory listing, no templates, no reverse proxy to an app"` | Accepted: Caddy follows symlinks under /srv/lp (`landing-pages.md "## Residual risk (accepted)"`) |
| V5.3.2 | 1 | Met | Storage paths from generated UUIDs (`apps/admin/src/lib/settings/lp-hosting.ts:59, 191, 254-255`; `uploads.ts:367`; `files.ts:37-38, 97`). Tests: `lp-zip.test.ts > "refuses traversal, absolute paths, drive letters, backslashes and NUL (zip.ts), whatever the extension"`; `files.int.test.ts > "serves only the deliverable paths, only on the api origin, and nothing outside the data directory"` | |
| V5.4.1 | 2 | Met | Fixed `Content-Disposition: attachment; filename="ebook.pdf"` (`files.ts:110`) | |
| V5.4.2 | 2 | Met | As V5.4.1; e-mail attachment names allowlisted (`smtp.ts:116-118`). Test: `settings.int.test.ts > "refuses an unsafe original file name at init (it may become an attachment name)"` | |
| V5.4.3 | 2 | Not met | No antivirus scanning (grep: none); PDFs accepted on magic bytes (`policy.ts:26-28`) | **Accepted risk** (Owner decision 2026-11-22, see the summary): uploads by 2FA admins only, type-checked and sanitized, scanned locally by the Owner before upload |

## V6 Authentication

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V6.1.1 | 1 | Met | Admin lockout 5 / 15 min, hard lock at 20 (`apps/admin/src/lib/auth/throttle.ts:22-26, 71-134`); player: per IP and /48, Cap, per-phone cooldown and caps (`play/handlers.ts:221-268`, `limits.ts:27-35`, `functions.sql:153-166`). Runbooks `admin-access.md "## 3. Sign-in rules (for support questions)"`, `staging-provision.md "### Operator steps"` | Admin login has no captcha (lockout + IP allowlist instead) |
| V6.1.2 | 2 | Met | The context words are documented in code: the product's names (`apps/admin/src/lib/auth/password-policy.ts:18`), the account's e-mail local part and the console domain's labels (`:33-45`); a password that is little more than them is refused (`:56`). Test: `password-policy.test.ts > "refuses a password that is the product's, the domain's or the e-mail's words plus a little"` | |
| V6.1.3 | 2 | Met | All pathways together with their controls: the appendix below; `admin-access.md "## 3"` and `"## 4. Recover a locked-out account"` | |
| V6.2.1 | 1 | Met | 12 to 128 characters (`instance.ts:170-171`, `request.ts:3`, `password-policy.ts:50`, `service.ts:335`). Test: `auth-flow.int.test.ts > "enrolls: current + new password, secret + QR + 10 hashed recovery codes, first code; other sessions are revoked"` | |
| V6.2.2 | 1 | Partial | The password is changed at enrolment (`service.ts:323-398`); Owner reset / CLI recover set a new one (`admin-users.ts:178-195`) | After enrolment an admin cannot change their own password. Follow-up: an Account "change password" action (current + new + TOTP) |
| V6.2.3 | 1 | Met | Current password required and new must differ (`service.ts:335, 349-352`); test as V6.2.1 | |
| V6.2.4 | 1 | Met | The 10,000 most common passwords of 12+ characters (SecLists Pwdb_top-1000000, MIT; `apps/admin/src/lib/auth/common-passwords.ts`, docs/versions.md), refused case-insensitively (`password-policy.ts:52`) wherever a password is set (`admin-users.ts:39, 46, 205, 244`; `service.ts:341`). Tests: `password-policy.test.ts > "refuses a common password whatever its case, and accepts an uncommon one"`; `> "is the rule of a new account (an Owner bootstrap, a new Staff member)"` | |
| V6.2.5 | 1 | Met | Length is the only rule (`password-policy.ts:50`, `service.ts:335`) | |
| V6.2.6 | 1 | Met | `type="password"` (`(auth)/login/login-form.tsx:21`, `enroll-flow.tsx:29, 33`, `team/create-staff-form.tsx:32`, `team/reset-form.tsx:29`) | No test asserts it |
| V6.2.7 | 1 | Met | `autocomplete` username / current-password / new-password, no paste blocking (`login-form.tsx:17, 21`; `enroll-flow.tsx:29, 33`) | |
| V6.2.8 | 1 | Met | No trim or case change of passwords (`apps/admin/src/lib/form-state.ts:43-46`); argon2 verify (`instance.ts:174`) | The CLI trims a trailing newline of a piped temporary password (`apps/admin/src/cli/admin.ts:38`) |
| V6.2.9 | 2 | Met | Up to 128 (`instance.ts:171`) | |
| V6.2.10 | 2 | Met | No expiry or forced rotation (grep) | |
| V6.2.11 | 2 | Met | As V6.1.2: product, domain and e-mail words (`password-policy.ts:33-56`) at every place a password is set | |
| V6.2.12 | 2 | Met | Every password set (a new account, a staff reset, the CLI recover, enrolment, the forced change) records a check: the SHA-1 sealed to the messaging key in an `admin.password_hibp_check` outbox job, payload ids only (`apps/admin/src/lib/auth/password-check.ts`). The worker asks Have I Been Pwned's range API with k-anonymity (5 hex characters, `Add-Padding`, safe-fetch, 3 s; `packages/adapters/src/pwned-passwords.ts`), retries with backoff and fails open, and flags a breached password (`apps/worker/src/password-check.ts`; `flag_breached_admin_password` in `functions.sql`); a flagged Owner or Staff session may only change the password (`apps/admin/src/lib/access.ts`). Tests: `apps/worker/test/password-check.int.test.ts > "flags a breached password of an Owner and of a Staff member: the flag, one warning alert with the admin id only, an audit row; the hash is wiped"`, `> "retries an unreachable API with backoff, then gives up without a flag (fail open), and wipes the hash at the end"`; `apps/admin/test/password-check.int.test.ts > "a new account, a staff reset, the CLI's recover and the enrolment each write one job for the password they set"`; `access.test.ts > "keeps a session whose password is in a known breach on the change page, Owner and Staff alike (US-031)"` (the API is always faked) | |
| V6.3.1 | 1 | Met | `throttle.ts:71-134`; `service.ts:163-193, 214-266`; player `handlers.ts:271-278, 300-317`, `otp.ts:64-71`. Tests: `lockout.int.test.ts > "locks the account after 5 failures: the right password is refused for 15 minutes, from any address"`, `> "lets at most 5 of many concurrent guesses reach the password check"`; `e2e/tests/admin-auth.spec.ts > "lockout: after 5 failed passwords the account is locked, even for the right password from another address"` | |
| V6.3.2 | 1 | Met | Group roles NOLOGIN (`packages/db/sql/roles.sql:13-15`); no seeded admin; first Owner only via the CLI, once (`admin-users.ts:78-81, 109-112`). Tests: `roles.int.test.ts > "creates the five roles as NOLOGIN with no elevated attributes"`; `cli.int.test.ts > "bootstraps the first Owner once, audited as the CLI; the password never appears in output or audit"` | |
| V6.3.3 | 2 | Partial | Admin: TOTP forced (`session.ts:60-61`, `instance.ts:125-132, 194`). Test: `e2e/tests/admin-auth.spec.ts > "forced 2FA: a new Owner can reach nothing but enrollment; afterwards sign-in asks for the code"` | Players: one factor (appendix: accepted, low-value accounts) |
| V6.3.4 | 2 | Met | Better Auth's HTTP handler mounted nowhere; stock phone routes disabled; no sign-up, no trusted device (`instance.ts:5-8, 168, 203`; `play/auth.ts:14-16, 257, 273-276`). Tests: `apps/admin/src/app/guards.test.ts > "its HTTP handler is mounted nowhere (the console calls auth.api from its own actions)"`; `play/guards.test.ts > "Better Auth's HTTP handler is mounted nowhere (the play routes call auth.api behind their own checks)"`; `play-auth.int.test.ts > "the stock send-otp is short-circuited: it stores nothing and sends nothing (R13)"` | |
| V6.4.1 | 1 | Partial | Temporary passwords expire after 72 h and cannot stay (`admin-users.ts:22, 61-63`; `service.ts:335`); magic links 256-bit, 72 h, single use (`packages/core/src/magic-link.ts:30-32`). Test: `auth-flow.int.test.ts > "is set when the account is created; after it the account cannot sign in, and an unfinished session ends"` | Temporary passwords are typed by the Owner, not generated. Follow-up: generate them |
| V6.4.2 | 1 | Met | No hints or secret questions (grep) | |
| V6.4.3 | 2 | Partial | No self-service reset; Owner reset / CLI recover turn TOTP off and require re-enrolment (`admin-users.ts:178-195`; `admin-access.md "## 4"`) | Every reset also resets the MFA (re-enrolled at once); no reset keeps TOTP. Risk Low (Owner-mediated, audited) |
| V6.4.4 | 2 | Met | Recovery codes, else Owner / CLI after an out-of-band identity check (`admin-users.ts:199-228, 237-272`; `admin-access.md "## 4"`). Tests: `cli.int.test.ts > "recovers a locked-out admin: TOTP off, codes and sessions gone, lockout cleared, new password; audited"`; `auth-flow.int.test.ts > "refuses another Owner (Owner recovery is CLI-only), audited, and changes nothing"` | |
| V6.5.1 | 2 | Met | TOTP replay guard (`service.ts:147-154, 238`), recovery codes (`recovery-codes.ts:49`), player OTP (`otp.ts:82-83`), magic links (`functions.sql:771-784`). Tests: `auth-flow.int.test.ts > "refuses a TOTP code that was already used (replay), even on a new challenge"`; `player-auth.int.test.ts > "consume: of concurrent consumers exactly one wins"` | |
| V6.5.2 | 2 | Met | Recovery codes argon2id (`recovery-codes.ts:16`); OTP HMAC-SHA256 with a pepper (`packages/core/src/otp.ts:60-65`); magic links SHA-256 of 256 bits (`magic-link.ts:23-32`). Test: `play-auth.int.test.ts > "moves the sealed code into the outbox: player_otps keeps only the HMAC"` | |
| V6.5.3 | 2 | Met | CSPRNG (`recovery-format.ts:12`, `core/otp.ts:55`, `magic-link.ts:31`; TOTP seed via Better Auth getRandomValues). Tests: `packages/core/src/otp.test.ts > "draws uniformly from crypto.randomInt(0, 10^6) and keeps leading zeros"`; `magic-link.test.ts > "creates a 256-bit base64url token and its SHA-256 (the expiry is the database's)"` | |
| V6.5.4 | 2 | Met | OTP 6 digits (`core/otp.ts:18`); recovery codes 80 bits | |
| V6.5.5 | 2 | Met | TOTP 30 s (`instance.ts:202`); 2FA challenge 5 min; OTP default 300 s, at most 600 s (`packages/db/src/schema/governance.ts:348`, the `app_settings_bounds_check` of migration 0023, which clamps a stored larger value first), and clamped by trigger (`triggers.sql:338-351`). Test: `content-forms.test.ts > "limits: every key bounded, all required, cooldown shorter than the code validity"` | |
| V6.6.1 | 2 | Partial | The OTP goes only to the phone of an eligible paying player (`functions.sql:144-151, 647-662`); a magic link by e-mail is the alternative | The phone is the checkout's, not proven; no stronger factor offered (accepted, appendix) |
| V6.6.2 | 2 | Met | MAC binds phone and code; a new code deletes the older ones (`core/otp.ts:64`, `otp.ts:40, 68`). Test: `otp.test.ts > "binds the code to the phone"` | |
| V6.6.3 | 2 | Met | 5 attempts per code, per-phone verify caps 10/network and 30/day, per IP, 250 ms floor (`otp.ts:64-71`, `handlers.ts:271-278, 309-327`). Tests: `play-auth.int.test.ts > "allows 5 attempts per code (counted atomically, also in parallel); the right code then fails too"`, `> "checks at most 10 codes a day per (phone, client network) and 30 per phone, for EVERY phone (known or not), then 429"` | |
| V6.8.1 | 2 | N/A | No identity provider | |
| V6.8.2 | 2 | N/A | No IdP assertions | |
| V6.8.3 | 2 | N/A | No SAML | |
| V6.8.4 | 2 | N/A | No IdP | |

## V7 Session Management

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V7.1.1 | 2 | Met | The appendix (admin 30 min / 12 h; player 30 days, daily rotation, 90-day cap, with the reason); `admin-access.md "## 3"` | |
| V7.1.2 | 2 | Met | The appendix (concurrent sessions: allowed, and why) | |
| V7.1.3 | 2 | N/A | No federated identity | |
| V7.2.1 | 1 | Met | Admin: one SQL check of state, idle and absolute limits (`apps/admin/src/lib/auth/session.ts:35-63`); player (`play/handlers.ts:466-472`, `auth.ts:144-153`). Tests: `auth-flow.int.test.ts > "refuses a session without session_state (not created by the console's sign-in flows)"`; `play-auth.int.test.ts > "a forged or unsigned cookie is anonymous"` | |
| V7.2.2 | 1 | Met | A token per session (Better Auth createSession) | |
| V7.2.3 | 1 | Met | 32 characters over 62 symbols, about 190 bits, getRandomValues (`@better-auth/core/dist/utils/id.mjs:3-5`) | No repo test of the entropy |
| V7.2.4 | 1 | Met | Admin: the second factor creates a new session (`instance.ts:110`); player: login revokes the incoming session, daily rotation (`handlers.ts:281-283`, `auth.ts:154-175`). Tests: `play-auth.int.test.ts > "a login replaces the session the browser came with (rotate on login)"`, `> "rotate once a day: a new token on the next use, the old one valid only for the grace period; one rotation under concurrency"` | |
| V7.3.1 | 2 | Met | Admin 30 min idle (`session.ts:49`); player: a session unused for 30 days ends (documented decision, appendix). Tests: `auth-flow.int.test.ts > "expires after 30 minutes idle"`; `e2e/tests/admin-auth.spec.ts > "sign-out after the idle timeout still lands on /login and clears the cookie"` | |
| V7.3.2 | 2 | Met | Admin 12 h, never refreshed (`session.ts:48`); player 90 days (`auth.ts:74, 147-153`). Tests: `auth-flow.int.test.ts > "expires 12 hours after sign-in, however active"`; `play-auth.int.test.ts > "are capped at 90 days from the login: a rotation carries the login over and never outlives it; past it the session ends"` | |
| V7.4.1 | 1 | Met | Server-side deletion (`service.ts:513-519`; `handlers.ts:434-443`). Tests: `auth-flow.int.test.ts > "signs out: audited before and after, the session row is gone and the cookie is cleared"`; `play-auth.int.test.ts > "logout deletes the session and expires the cookie"` | |
| V7.4.2 | 1 | Met | Disable deletes admin sessions (`admin-users.ts:130`); a suspended / anonymized player resolves to nobody on every request (`functions.sql:667-678`). Tests: `auth-flow.int.test.ts > "refuses a disabled admin: sessions are revoked and no new one is created"`; `player-auth.int.test.ts > "player_for_login answers NULL once the player is no longer eligible or is anonymized"` | |
| V7.4.3 | 2 | Partial | TOTP enrolment revokes every other session (`service.ts:421`); reset / recover delete all (`admin-users.ts:187`) | Regenerating recovery codes offers no "end other sessions". Follow-up with V6.2.2 |
| V7.4.4 | 2 | Met | `(console)/layout.tsx:82-85`; player `account-menu.tsx:43-49`, `signed-in-panel.tsx:22`. Test: `e2e/tests/play-login.spec.ts > "the signed-in panel's sign-out ends the session"` | |
| V7.4.5 | 2 | Partial | The Owner's Disable / Reset ends a Staff member's sessions (`admin-users.ts:130, 187`) | No "end sessions" short of that; no admin control over a player's sessions. Follow-up |
| V7.5.1 | 2 | Met | New recovery codes need a current TOTP; enrolment the current password (`service.ts:349-352, 439-441`); no e-mail / phone change feature. Test: `auth-flow.int.test.ts > "can be regenerated with a current authenticator code; the old ones stop working"` | |
| V7.5.2 | 2 | Partial | Player "log out everywhere" (`auth.ts:189-194`); test `play-trivia.int.test.ts > "ends every session of the player, and only theirs"` | Nobody can list their sessions; admins cannot end their other sessions. Follow-up |
| V7.6.1 | 2 | N/A | No IdP | |
| V7.6.2 | 2 | Met | The magic link's GET shows a confirm page; only the click logs in (`masuk/page.tsx:1-2`; `magic-link-confirm.tsx:27-38, 94`). Test: `e2e/tests/play-login.spec.ts > "a magic link: the GET shows a confirm page and consumes nothing; the click logs in once; a replay is refused"` | |

## V8 Authorization

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V8.1.1 | 1 | Met | `apps/admin/src/lib/policy.ts:1-11, 19-88, 102-119`; `packages/db/sql/grants.sql:10-27`. Tests: `policy.test.ts > "lists exactly the permissions the expected table covers"`; `roles.int.test.ts > "pins the full privilege matrix"` | |
| V8.1.2 | 2 | Met | Field-level grants with their reasons (`grants.sql:79-96, 149-158, 367-370, 465-481`). Tests: `roles.int.test.ts > "pins the column list of every table public_rw / internal_rw reach by a table-level grant"`, `> "gives public_rw no privilege at all on public.players, table or column"` (US-031) | |
| V8.2.1 | 1 | Met | `require-admin.ts:21-26`; `policy.ts:104-119` (fails closed); `withPlayer` (`handlers.ts:490-503`). Tests: `guards.test.ts > "match the table exactly: every page, layout, action and route with its requirement"`; `e2e/tests/admin-auth.spec.ts > "Staff get 403 on Owner-only pages and actions, and those controls are hidden"` | |
| V8.2.2 | 1 | Met | The player id comes from the session and every row is checked against it (`play.sql:388-393, 468-478, 563-578, 605-610, 639-656`); the order id is a 131-bit capability (`packages/core/src/ids.ts:12-13, 27`); signed file URLs (`files.ts:64-77`). Tests: `play-flow.int.test.ts > "refuses another player's attempt and answer rows, and an option of another question (IDOR: ET140 / ET051)"`; `files.int.test.ts > "refuses a forged, tampered, expired or missing signature with one answer (403), and serves nothing"` | Accepted: public_rw can read every order's masked status (`order-status.int.test.ts > "gives a public_rw lateral dump over every public id only masked values: no raw name, phone or e-mail leaves the database"`) |
| V8.2.3 | 2 | Partial | Column grants; Staff export denial (`policy.ts:46-48`). Accepted (the Owner's decision, 2026-11-25): the console shows buyers' and players' names, WhatsApp numbers and e-mails in full to the Owner AND Staff (`docs/compliance/pii-inventory.md`); the order page keeps masking (`functions.sql` mask_name / mask_phone). The trivia site (the Owner's decision, 2026-11-25) shows a player's OWN name, number and e-mail on their profile (`player_profile_contact`, public_rw, keyed by the live session, not a player id: accepted risk, see the PII inventory) and the other players as the number with its last 4 digits hidden (`mask_phone_tail`, in SQL). Tests: `reports.int.test.ts > "is Owner-only in the policy: Staff may view reports, never export"`; `e2e/tests/admin-reports.spec.ts > "Staff view the reports but cannot export, see profit, edit ad spend or re-fire: the server refuses, not only the menu"` | Owner and Staff share `admin_rw` (summary) |
| V8.3.1 | 1 | Met | DEFINER entry points and INVOKER guards in the database, revoke-all baseline (`grants.sql:31-40`; `triggers.sql:216-246, 561-661`). Tests: `roles.int.test.ts > "leaves no function in public executable by PUBLIC"`, `> "fires every trigger on our tables ALWAYS"`; `play.int.test.ts > "public_rw writes no play row at all, and no score (42501, US-027)"` | |
| V8.4.1 | 2 | N/A | Single tenant (one Owner's business) | |

## V9 Self-contained Tokens

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V9.1.1 | 1 | Met | No JWT. Cap tokens: HMAC-SHA256, constant-time (`captcha.ts:185-196, 211-212`); signed URLs: domain-separated HMAC, canonical only (`signed-url.ts:23, 33-35, 61-71`). Tests: `captcha.test.ts > "refuses a token with ANY byte changed, another key, a challenge token and an expired one, without spending the real one"`; `signed-url.test.ts > "A3: refuses non-canonical base64url spellings of a valid signature"` | |
| V9.1.2 | 1 | Met | One fixed algorithm per token type, no algorithm field to choose | |
| V9.1.3 | 1 | Met | Keys only from the environment, at least 32 bytes (`packages/core/src/secret-key.ts:33-40`); the file key HKDF-derived for that purpose (`packages/crypto/src/file-url-key.ts:16-24`). Test: `file-url-key.test.ts > "is not the payment private key itself"` | |
| V9.2.1 | 1 | Met | Expiry checked (`captcha.ts:226-227, 292-293`; `signed-url.ts:72-74`, 72 h max). Test: `signed-url.test.ts > "refuses a URL whose expiry is further out than the longest one we mint, even with a valid signature"` | |
| V9.2.2 | 2 | Met | Challenge vs token: separate subkeys and a version byte (`captcha.ts:122-126, 211-212`); URL scheme versioned (`signed-url.ts:8-10`) | |
| V9.2.3 | 2 | Met | Cap scoped to its landing page (`captcha.ts:202-203, 224, 291`); files on api.<DOMAIN> only. Tests: `captcha.test.ts > "binds challenges and tokens to their landing page: another scope refuses both"`; `checkout.int.test.ts > "binds a Cap token to the landing page it was solved for (security review P2-3)"` | |
| V9.2.4 | 2 | Met | One key per purpose (Cap subkeys; the HKDF file key) | |

## V10 OAuth and OIDC

**N/A (29 requirements: V10.1.1-V10.1.2, V10.2.1-V10.2.2, V10.3.1-V10.3.4, V10.4.1-V10.4.11, V10.5.1-V10.5.5,
V10.6.1-V10.6.2, V10.7.1-V10.7.3).** The system is neither an OAuth client, resource server, authorization server nor
OpenID Provider: Better Auth runs with credentials + TOTP (admin) and the phone plugin (players) only, no social or
generic OAuth provider (grep), and no third party is given delegated access.

## V11 Cryptography

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V11.1.1 | 2 | Partial | Rotation procedures: `admin-access.md "## 5. Rotate ADMIN_AUTH_SECRETS"`, `staging-provision.md "## Routine operations"` | No consolidated key-management policy; no re-seal procedure after a scope-key rotation; none for the messaging / conversions keys. Follow-up: docs/runbooks/keys.md |
| V11.1.2 | 2 | Partial | Inline designs: `packages/crypto/src/sealed-box.ts:1-15`, `file-url-key.ts:1-11`, `signed-url.ts:1-10`, `captcha.ts:86-107`, `apps/admin/src/lib/auth/argon2.ts:1-8` | No crypto inventory document. Follow-up with V11.1.1 |
| V11.2.1 | 2 | Met | node:crypto only (`sealed-box.ts:17-28`). Test: `packages/crypto/src/kat.test.ts > "sealed box: seal with a fixed ephemeral key gives the vector byte for byte; open reverses it"` (independent known-answer vectors) | |
| V11.2.2 | 2 | Partial | Versioned formats: signed URLs (`signed-url.ts:8-10`), Cap version byte, sealed-box key ids (`sealed-box.test.ts > "key_id = first 16 hex chars of SHA-256(raw public key); the private key derives the public key"`) | The sealed-box format names no algorithm: a cipher change needs a new format version. Follow-up: a version byte in the sealed envelope |
| V11.2.3 | 2 | Met | X25519, AES-256-GCM, HMAC-SHA256, 256-bit keys (`secret-key.ts:33-40`; `infra/provision/lib.sh:229`) | |
| V11.3.1 | 1 | Met | AES-GCM only; no ECB, no RSA (grep) | |
| V11.3.2 | 1 | Met | AES-256-GCM with a 16-byte tag (`sealed-box.ts:127-131`) | |
| V11.3.3 | 2 | Met | AEAD with AAD, fails closed (`sealed-box.ts:149-152, 167-178`). Tests: `sealed-box.test.ts > "fails closed when any single byte (eph_pub, ciphertext or tag) is flipped"`; `secrets.test.ts > "fails closed on an AAD swap: another row id, scope, name, adnet_id or bound_host"` | |
| V11.4.1 | 1 | Met | SHA-256 family only; no MD5 / SHA-1 in source or SQL (grep); TOTP's HMAC-SHA1 is RFC 6238's | |
| V11.4.2 | 2 | Met | argon2id m=19456 KiB, t=2, p=1 (`argon2.ts:2, 8`). Test: `argon2.test.ts > "hashes with argon2id and the pinned parameters, salted per hash"` | |
| V11.4.3 | 2 | Met | 256-bit outputs for integrity (HMAC-SHA256, SHA-256 key ids, HKDF-SHA256) | |
| V11.4.4 | 2 | N/A | No key is derived from a password | |
| V11.5.1 | 2 | Met | CSPRNG everywhere (`magic-link.ts:31`, `ids.ts:3, 25`, `signed-url.ts:46`, `captcha.ts:260`, `gen_random_uuid`); no Math.random (grep). Test: `magic-link.test.ts > "never repeats a token, and keeps one independent token per channel"` | |
| V11.6.1 | 2 | Partial | X25519 generation and low-order point refusal (`sealed-box.ts:92-115`). Test: `sealed-box.test.ts > "rejects every low-order recipient public key, and an opened box with a low-order eph_pub"` | No production key-generation tool or procedure for the escrowed scope keys. Follow-up with V11.1.1 |

## V12 Secure Communication

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V12.1.1 | 1 | Staging-pending | No TLS override: Caddy 2.11.9 defaults (TLS 1.2 and 1.3; `infra/caddy/adapted.test.json` tls_connection_policies `[{}]`); outbound SMTP `minVersion: TLSv1.2` (`smtp.ts:165`) | Prove on staging with a TLS scan (testssl.sh / sslyze); add to security-scans.md when the VM exists |
| V12.1.2 | 2 | Staging-pending | Caddy (Go) default suites: AEAD with ECDHE only | As V12.1.1 |
| V12.1.3 | 2 | N/A | No mTLS | |
| V12.2.1 | 1 | Met | HTTPS on fd/4, port 80 redirects, HSTS (`Caddyfile:113-131, 210-223`). Test: `caddyfile.test.ts > "sets HSTS, nosniff and frame-ancestors 'none' on the app hosts, HSTS and nosniff on LP hosts"` | |
| V12.2.2 | 1 | Staging-pending | ACME by TLS-ALPN-01; LP certificates on demand for approved hosts only (`Caddyfile:19-35`). Test: `caddyfile.test.ts > "gets certificates by TLS-ALPN only, and LP certificates only when internal:9000 approves the host"` | `infra/verify/lp-tls-check.sh` and host-check on the VM |
| V12.3.1 | 2 | Partial | Outbound TLS: safe-fetch https only (`safe-fetch.ts:244-246`), SMTP TLS (`smtp.ts:162-165`), Kuma https in production (`apps/worker/src/worker-config.ts:137-139`) | Internal hops plaintext (V12.3.3) |
| V12.3.2 | 2 | Met | Default certificate verification (`safe-fetch.ts:227-233`; `smtp.ts:165` rejectUnauthorized + servername) | No test with a bad certificate |
| V12.3.3 | 2 | Not met | Caddy to apps and internal:9000, apps to PostgreSQL and Valkey are plain on podman `Internal=true` networks (`infra/quadlet/ebt-*.network:10`; `pg_hba.conf` `host`) | **Accepted risk** for the single VM (summary) |
| V12.3.4 | 2 | N/A | No internal TLS, so no internal certificates (see V12.3.3) | |

## V13 Configuration

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V13.1.1 | 2 | Partial | `infra/quadlet/ebt-edge.network:1-3`; `conversions.md "## What is sent"`; `delivery.md "## What to set up"`; `Caddyfile:12-15`; `ebt-egress.nft` | No single communication inventory. Follow-up |
| V13.2.1 | 2 | Met | One PostgreSQL login per app, one group, SCRAM (`db-roles.sh:95-132`); Valkey ACL user per app, default off (`users.acl.template:1-5`). Tests: `roles.int.test.ts > "refuses to migrate while a LOGIN role is in two groups, directly or indirectly (ET091)"`; `prod-valkey-acl.int.test.ts > "refuses the default user and wrong passwords"` | |
| V13.2.2 | 2 | Met | Least privilege per role and ACL user (`grants.sql`; US-031: public may only FCALL). Tests: `roles.int.test.ts > "pins the full privilege matrix"`; `prod-valkey-acl.int.test.ts > "confines every user to its keys and keeps @dangerous / @admin away from all of them"`, `> "US-031: the worker loads public's function at start, after a reconnect and after a flush; public may only FCALL it"` | `ebt_migrate` is a superuser login (one-shot migrate job) |
| V13.2.3 | 2 | Met | Passwords generated on the VM (`provision.sh:428-457, 484-495`); dev values only in infra/dev (`-devonly`) | |
| V13.2.4 | 2 | Partial | safe-fetch; postback host bound to the adnet (`template.ts:27-32`); internal networks | No outbound allowlist (summary); PostgreSQL's wal-g egress on `ebt-backup` is unrestricted, an accepted v1 risk (`backups.md`) |
| V13.2.5 | 2 | Partial | As V13.2.4 | As V13.2.4 |
| V13.3.1 | 2 | Partial | Generated on the VM, env files 0640 root:ebt (`provision.sh:484`; the runbook and the env templates now say the same, US-031); private keys only where needed. Tests: `settings.int.test.ts > "the admin process holds no opener: its env refuses private keys and an opener cannot be built from it"`; `quadlets.test.ts > "generate env files whose secrets are created on the VM, never written in the repository"`; gitleaks clean (security-scans.md section 1) | No secrets manager (summary) |
| V13.3.2 | 2 | Partial | Private keys per process (payment key in public, messaging and conversions keys in the worker only) | All env files are readable by the one app user that runs every container |
| V13.4.1 | 1 | Met | `.dockerignore:10-12` (no .git, .github, docs); runtime stages copy build output only (`infra/images/app/Containerfile:81-107`) | No test asserts `.git` is excluded |
| V13.4.2 | 2 | Partial | NODE_ENV=production in images; dev flags refused in production (`worker-config.ts:13-19, 146-150`; `apps/public/src/lib/config.ts:93, 151, 212`). Tests: `worker-config.test.ts > "refuses %s in production, whatever its value"`; `config.test.ts > "allows a loopback play origin outside production only (the e2e server)"` | `ADMIN_ALLOW_INSECURE_LOOPBACK` and `ENABLE_MOCKUPS=1` are not refused in production by the apps (host-check checks the first only). Follow-up |
| V13.4.3 | 2 | Met | `file_server { hide .* }`, no browse, index.html only (`Caddyfile:363-365, 443-446`). Test: `caddyfile.test.ts > "runs file_server only: no directory listing, no templates, no reverse proxy to an app"` | |
| V13.4.4 | 2 | Met | US-031: TRACE and TRACK answer 405 at the edge on every host (`Caddyfile:203-206`). Tests: `caddyfile.test.ts > "answers TRACE and TRACK with 405 on every host, before any app (US-031, ASVS V13.4.4)"`; `security-headers.sh` probes `TRACE (refused at the edge)` on admin and api | |
| V13.4.5 | 2 | Met | Caddy admin off (`Caddyfile:18`); `/internal*` and `/livez*` 404 everywhere (`:199-202`); internal:9000 on a Caddy-only network. Tests: `caddyfile.test.ts > "has the admin API off"`, `> "blocks /internal (and the load balancer's /livez) on every host"`; `quadlets.test.ts > "isolate admin and internal: each shares a private network with Caddy only"` | |

## V14 Data Protection

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V14.1.1 | 2 | Met | `docs/compliance/pii-inventory.md` (US-030): every text, varchar, jsonb, inet and bytea column of every table classified PII, pseudonymous or not PII, with what an erasure does to it. Test: `privacy.int.test.ts > "finds no marker of the erased subject in any text, jsonb, inet or bytea column of any table; the other subject is intact; reports unchanged"` (scans every such column, so a new one is covered) | |
| V14.1.2 | 2 | Partial | Per column: the erasure (pii-inventory.md), the retention of strangers' WhatsApp contacts (7 days) and of backups (14 days, docs/runbooks/privacy.md), PII-free logs by construction (V16.2.5) | No single per-level requirement set (encryption at rest, caching, logging per class) (summary) |
| V14.2.1 | 1 | Partial | Magic-link token in the fragment (`packages/core/src/magic-link-url.ts:6-10, 29-35`), stripped after reading; order id stripped before vendors load and redacted from logs (`Caddyfile:90-111`); `/files/` and hook URIs redacted (`Caddyfile:59, 74`). Tests: `magic-link-url.test.ts > "puts the channel and the token in the fragment of the confirm page"`; `caddyfile.test.ts > "redacts the GlitchTip token and every /files URI, query included, from every log"`; `order.int.test.ts > "does not log a public id, a name, a phone number or an e-mail address"` | Bearer capabilities by design in URLs: signed file URLs (query), the order id (path), the GlitchTip token (path). Caddy's `log default` (errors) does not redact the order id |
| V14.2.2 | 2 | Met | No caching layer in Caddy; no-store on the API, files, order, play, admin (`http.ts:15`, `files.ts:54`, `csp.ts`, `apps/admin/src/proxy.ts:14, 40-41`). Tests: `security-headers.test.ts > "requires no-store on JSON and the CORS / CORP of the SDK files"`; `caddyfile.test.ts > "caches a versioned file for a year as immutable and the alias for 5 minutes, and nothing else"` | |
| V14.2.3 | 2 | Partial | Browser pixels carry event id, transaction id and value only; Meta automatic advanced matching off (`apps/public/src/lib/order/pixels.ts:9, 96-97`); Referrer-Policy strict-origin. Tests: `pixels.test.ts > "fires all registered vendors, each library once, and nothing personal anywhere"` | Server-side CAPI sends hashed e-mail / phone and IP (by design, consent-based, `conversions.md "## What is sent"`); vendor scripts can read the order id (accepted, `docs/decisions/order-pixel-iframe.md`) |
| V14.2.4 | 2 | Partial | Erasure by anonymization (`public.erase_data_subject`, `packages/db/sql/privacy.sql:67`; docs/runbooks/privacy.md), the stranger-contact retention sweeper (`apps/worker/src/sweepers.ts:521`, `prune_stranger_wa_contacts`), sealed secrets (V11), masked names and phones on every public read. Tests: `privacy.int.test.ts` (as V14.1.1); `sweepers.int.test.ts > "deletes stale stranger rows only, through prune_stranger_wa_contacts (worker_rw cannot delete wa_contacts itself)"` | No database encryption at rest; buyer data has no time-based retention (kept until an erasure request, the privacy policy's choice) (summary) |
| V14.3.1 | 1 | Partial | Logout deletes the server session and expires the cookie (V7.4.1 tests) | No `Clear-Site-Data`. Follow-up: send it on both logouts |
| V14.3.2 | 2 | Met | no-store on every sensitive page (V14.2.2); test `security-headers.test.ts > "fails an app page without the nonce CSP, or with unsafe script sources, framing, caching or COOP"` | |
| V14.3.3 | 2 | Partial | Session cookies HttpOnly; SDK storage limited by test (`packages/sdk/src/attribution.test.ts > "never writes anything else to sessionStorage, and nothing but the click and the names to localStorage"`) | sessionStorage holds the order id (a capability; accepted) |

## V15 Secure Coding and Architecture

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V15.1.1 | 1 | Met | Remediation time frames: `security-scans.md "## 1. Secret and dependency scans"` (US-031) | |
| V15.1.2 | 2 | Partial | pnpm-lock.yaml; docs/versions.md; images pinned by digest (test `quadlets.test.ts > "pin every base image by digest: quadlets, Containerfiles and Dockerfiles"`) | No SBOM (CycloneDX / SPDX). Follow-up: `osv-scanner` or `cdxgen` SBOM artifact in CI |
| V15.1.3 | 2 | Partial | Per feature: `landing-pages.md "## What a ZIP may hold"`, `docs/decisions/public-cache-valkey.md`, sharp limits (`packages/uploads/src/sniff.ts:34-46`) | No single inventory of resource-heavy features. Follow-up |
| V15.2.1 | 1 | Met | OSV clean in CI and locally; the two overrides (package name and version) are dev-only and inside the 90-day frame (`osv-scanner.toml`); GHSA-w5hq (moderate) fixed (`pnpm-workspace.yaml` `exceljs>uuid`) | Base images are not scanned by OSV (monthly check per the frames) |
| V15.2.2 | 2 | Met | Body limits and timeouts (`Caddyfile:45-51, request_body` blocks), JSON 16 KiB (`http.ts:21`), sharp pixel cap / timeout / concurrency 2, ZIP budgets, safe-fetch timeouts and body caps. Tests: `caddyfile.test.ts > "bounds slow clients: 10 s for headers, 30 s for a body, 10 min to write a response (a 100 MB PDF on a slow link)"`; `policy.test.ts > "re-encodes at most imageMaxConcurrency images at once"`; `safe-fetch.test.ts > "refuses a gzip bomb once the decoded body passes the 1 MiB default"` | |
| V15.2.3 | 2 | Partial | Mockups 404 unless `ENABLE_MOCKUPS=1` (`apps/public/src/lib/mockups.ts:7-9`); test files removed from images (`Containerfile:76-77`) | `ENABLE_MOCKUPS=1` accepted in production (V13.4.2 follow-up) |
| V15.3.1 | 1 | Met | DEFINER functions return minimal, masked JSON (`functions.sql:488-560`; `play.sql:528-539`). Test: `order-status.int.test.ts > "returns the page's fields for a known public id, with the buyer MASKED by the product's one rule (mask_name / mask_phone) and no raw name, phone, e-mail, internal id or attempt data"` | |
| V15.3.2 | 2 | Met | No redirects followed (`safe-fetch.ts:266-269`; `conversions.ts:211-218`). Test: `conversions.int.test.ts > "never follows a redirect, whatever it points at, and does not take it for a retryable no: the sink got the request (security review US-024 M2)"` | |
| V15.3.3 | 2 | Met | Explicit field mapping and column-level UPDATE grants (`request.ts:86-101`; `grants.sql:87-96, 361-364, 500-506`). Tests: `orders.int.test.ts > "public_rw cannot UPDATE the priced columns afterwards (42501)"`; `play.int.test.ts > "cannot move a play row to another player or set (42501)"` | |
| V15.3.4 | 2 | Met | As V4.1.3; rate limits use the resolved address (`client-ip.ts`) | |
| V15.3.5 | 2 | Partial | TypeScript strict, `strictTypeChecked` lint (`tsconfig.base.json:9-13`, `eslint.config.js:25`) | No `eqeqeq` rule (`!= null` in 3 places). Follow-up |
| V15.3.6 | 2 | Met | Untrusted JSON is `unknown`, read by fixed keys into fresh objects (`order/handler.ts:78`, `request.ts:172-181`, `Object.hasOwn` in `order/view.ts:26`); no deep merge | No `__proto__` payload test |
| V15.3.7 | 2 | Met | Single-value `searchParams.get`; the signature covers `exp` and `n`; JSON bodies only for APIs | |

## V16 Security Logging and Error Handling

| ID | L | Status | Evidence | Gap / follow-up |
|---|---|---|---|---|
| V16.1.1 | 2 | Partial | `security-scans.md "## 5. Security alerts and log monitors"`; `order-status-page.md "## Access logs"`; `conversions.md "## Logs"` | No logging inventory. Follow-up (US-015) |
| V16.2.1 | 2 | Partial | `role`, `event`, `route`, `reason` (`apps/public/src/lib/log.ts:10, 39-46`; `apps/admin/src/lib/log.ts`); journald adds time and unit | No actor / client reference in public lines; app request ids do not match Caddy's. Follow-up |
| V16.2.2 | 2 | Met | chrony provisioned and checked (`provision.sh:356-364`; `host-check.sh:159-162`); epoch timestamps (pino `time`, Caddy `ts`, journald) | |
| V16.2.3 | 2 | Met | `LogDriver=journald` everywhere; test `quadlets.test.ts > "run hardened: no new privileges, read-only roots, no capabilities, journald logs"` | journald retention not configured |
| V16.2.4 | 2 | Met | JSON lines everywhere (`log.ts`; pino; Caddy `wrap json`) | |
| V16.2.5 | 2 | Partial | Field allowlists + masking (`apps/public/src/lib/log.ts:10-29`); worker deep redaction (`apps/worker/src/log.ts:13-49`); Caddy filters (`Caddyfile:54-111`). Tests: `apps/admin/src/lib/log.test.ts > "drops every other field, so an e-mail, phone or password cannot be logged"`; `apps/worker/src/log.test.ts > "redacts credentials, headers, sealed material and secret payload fields at any depth"`; `checkout.int.test.ts > "never logs the buyer's name, phone or e-mail, nor the server key"` | The worker keeps `error.message` and stack (driver messages can quote values); Caddy's error log does not redact order ids. Follow-up |
| V16.3.1 | 2 | Partial | Admin audit rows for sign-in, failures, lockouts, sign-out (`service.ts:120-141, 182-202, 228-231, 515-517`); player `play.login` / `play.refused` | Player login lines carry no identity reference; no test of the success row. Follow-up |
| V16.3.2 | 2 | Partial | Play refusals logged (`play/trivia.ts:73-78`); admin cross-origin refusals logged (`actions.ts:38`, `route.ts:41`) | Admin policy 403s (`require-admin.ts:24`, `route.ts:50`) are not logged. Follow-up |
| V16.3.3 | 2 | Partial | Origin, rate-limit, captcha and signature refusals are logged (`checkout/handler.ts:104-164`, `play/handlers.ts:230, 276`, `files.ts:75, 85`, `webhooks/midtrans.ts:74, 86`). US-031: refused late reveals are counted, flagged and alerted (`play_reveal_misuse`), and every reveal leaves a server-log line (`play.sql:674`) that a caller's ROLLBACK cannot erase (test `play-flow.int.test.ts > "leaves a RAISE LOG line that a ROLLBACK cannot erase, while the rolled-back row and alert are gone (code review MAJOR 1)"`; the monitor: security-scans.md section 5); `public.valkey_function_missing` and the worker's `valkey_function_missing` alert | Refusal lines carry no client address; admin proxy 403 not logged |
| V16.3.4 | 2 | Met | Edge failures (`edge-server.ts`), `internal` lines (`play/handlers.ts:196-199`), security-control failures (`files.ts:70, 91`; `webhooks/midtrans.ts:123, 127`). Test: `wrappers.test.ts > "answers a bare 500 for any other error and logs only type and code"`; runbook `security-scans.md` log monitor | |
| V16.4.1 | 2 | Met | `JSON.stringify` lines, event names `^[a-z0-9_.]{1,64}$` (`log.ts:39-42`); test `admin log.test.ts > "refuses free-text event names"` | |
| V16.4.2 | 2 | Partial | Containers cannot reach the journal (read-only roots, no capabilities) | No journald hardening or retention; logs on the same VM |
| V16.4.3 | 2 | Not met | No log shipping yet (GlitchTip is an inbound alert hook only). US-015 decided the option: `systemd-journal-upload` to `systemd-journal-remote` on the monitoring box, mutual TLS, no new tool (`docs/decisions/off-host-logs.md`) | **Staging-pending** (go-live GL-20): needs the monitoring box and a certificate chain; stays Not met until a line written on the VM is found on the box |
| V16.5.1 | 2 | Met | Bare 500s, generic pages (`edge-server.ts`, `apps/public/src/app/error.tsx:7-23`). Tests: `edge-server.test.ts > "turns a failing app handler into a 500"`; `wrappers.test.ts > "replaces any other error with a bare one and logs only type and code"` | |
| V16.5.2 | 2 | Met | Fail closed on Valkey loss, Snap timeouts bounded, OTP breaker; a missing Valkey function fails the rate-limited routes closed (503) without taking the instance out of the load balancer, and the worker reloads it and alerts (US-031, `apps/worker/src/valkey-functions.ts`). Tests: `checkout.int.test.ts > "fails CLOSED with 503 while Valkey is unreachable (no rate limit, no single-use Cap check: no order)"`; `valkey-functions.int.test.ts > "missing: fails closed with 503 on the rate-limited routes and logs public.valkey_function_missing, until it is loaded again"`; `prod-valkey-acl.int.test.ts > "US-031: the worker loads public's function at start, after a reconnect and after a flush; public may only FCALL it"`; `chaos.int.test.ts > "FLUSHALL Valkey: all pending work (outbox and conversions) completes from PostgreSQL"` | |
| V16.5.3 | 2 | Met | `apps/public/src/proxy.ts:155-169` (order lookup fails closed); webhook 503 for Midtrans retries. Tests: `proxy.test.ts > "fails closed when the order lookup cannot run (no runtime): 503 text in Bahasa Indonesia, no page, no CSP"`; `webhook.int.test.ts > "503 (not 500) on a real database error: Midtrans retries a 503 four times and a 500 only once; the retry is stored"` | |

## V17 WebRTC

**N/A (7 requirements: V17.1.1, V17.2.1-V17.2.4, V17.3.1-V17.3.2).** No WebRTC, TURN, media or signaling server (grep).

## Appendix: documented decisions (V6.1.3, V7.1.1, V7.1.2, V6.3.3, V6.6.1)

**Authentication pathways (V6.1.3).** Every pathway, with the same controls wherever it is reached:

| Who | Pathway | Controls |
|---|---|---|
| Admin (Owner, Staff) | e-mail + password, then TOTP | lockout 5 failures / 15 min, hard lock at 20; forced TOTP (enrolment before anything else); admin IP allowlist at the edge; exact-Origin POSTs |
| Admin | e-mail + password, then a recovery code | the same lockout; each code once, argon2id-hashed |
| Admin | Owner "Reset access" (Staff) or `cli recover` (anyone) | out-of-band identity check by the Owner / operator; TOTP off, every session and code gone, re-enrolment forced; audited |
| Player | WhatsApp OTP to the order's phone | per IP, /48, phone cooldown and caps, a global breaker; Cap proof of work; 5 attempts per code; 300 s code (bounded 60-900 s) |
| Player | magic link (WhatsApp or e-mail) | 256-bit, single use, 72 h, one per channel; the GET only shows a confirm page, the click logs in |

There is no other pathway: Better Auth's HTTP handler is mounted nowhere, the stock phone routes are disabled, sign-up and
trusted devices are off (V6.3.4).

**Session lifetimes (V7.1.1, V7.3.x).** Admin: 30 minutes idle, 12 hours absolute, never refreshed (NIST SP 800-63B AAL2
re-authentication). Player: a session lives 30 days, is replaced by a new token on its first use after 24 hours, and never
outlives 90 days after the login that started it; an unused session ends after 30 days. The player limits deviate from
AAL2 on purpose: a player account holds only game state (no payment, no editable personal data, masked display) and is
opened from WhatsApp / e-mail links on a phone, where a short idle timeout would push players into repeated OTP sends (a
WhatsApp ban risk, plan pre-mortem 1).

**Concurrent sessions (V7.1.2).** Not limited, for admins or players. Admins: sessions are short (V7.1.1) and the Owner's
Disable / Reset ends every session of an account. Players: several devices are normal (phone and laptop); "log out
everywhere" ends all of them, and every login replaces the session the browser came with.

**Players' single factor (V6.3.3, V6.6.1).** Accepted by the product design: the phone is the one the buyer typed at
checkout (its WhatsApp receives the OTP and the ebook), and the account's value is bounded as above. A stronger factor
(TOTP for players) is not offered.
