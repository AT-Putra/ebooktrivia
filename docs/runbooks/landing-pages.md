# Hosted landing pages (ZIP upload, US-023)

A landing page is either **external** (hosted anywhere, it loads the SDK snippet itself) or **hosted from a ZIP**:
the Owner uploads a static site in **Settings, Landing pages, Hosted ZIP** and it is served on the page's registered
domains, with a certificate obtained on the first visit (Caddy on-demand TLS).

## What a ZIP may hold

The ZIP goes up in 1 MiB chunks (resumable, each chunk hash-checked), so even a slow connection fits Caddy's 30 s
limit per request; one publish runs at a time (a second one is told to retry). It is checked by
`packages/uploads/src/lp-zip.ts` while it is extracted into a staging folder; a refused ZIP shows every problem found,
the staging folder is thrown away and nothing is published. The refusal is in the audit log (`lp_version.reject`).

- At most 25 MB compressed, 150 MB uncompressed and 100 times its own size, 500 files, 25 MB per file. The sizes are
  measured while inflating; the ZIP's headers are not trusted.
- `index.html` at the top. A ZIP of one folder that holds `index.html` is read from inside that folder.
- Extensions: `.html .htm .css .js .mjs .json .map .txt .svg .png .jpg .jpeg .gif .webp .avif .ico .woff .woff2 .ttf
  .otf .mp4 .webm`. The content must match the extension (magic bytes for binary types, UTF-8 for text).
- Names: letters, digits, spaces inside, and `. _ ~ @ + , ( ) = ! ' -`; no hidden files, no `%`, `?` or `#`, no two
  names that differ only in case. Names are normalized to Unicode NFC first (macOS writes NFD), so `café` typed
  either way is one name.
- macOS metadata is skipped, never extracted: the `__MACOSX/` folder, `.DS_Store` and AppleDouble `._name` files. They
  still count against the 25 MB and the entry cap; the console says how many were skipped (also in the audit entry).
- No symlinks, devices or encrypted entries; stored or deflate compression only.
- SVG: unsafe SVGs are refused, never rewritten: an SVG is accepted only when every construct in it is on an
  allowlist (no script, `foreignObject`, event handlers, external references, `javascript:` URLs, entities, CSS
  escapes or `image-set()`), and is then stored as uploaded. Export plain SVG from the design tool.
- HTML: every page needs a `</head>`. The hosting adds `<script src="https://api.<DOMAIN>/sdk/v1.js"
  data-lp="lp_..." async></script>` right before it (a copy inside an HTML comment does not count), so the page must
  **not** load the SDK itself. That refusal catches a mistake; it is not a security boundary (the page's own scripts can
  do anything a script can).

Images keep their format and bytes (no re-encoding: the page's HTML refers to them by name). They are served with
their fixed Content-Type and `nosniff`, so no image is ever run as a page or a script.

## Serving

- `/srv/lp/versions/<lpId>/<n>`: one directory per version. `/srv/lp/hosts/<host>/current`: a symlink to the live
  version, switched by an atomic rename. The admin app writes `/srv/lp`; Caddy reads it; the worker (which holds the
  private keys) has no access.
- A domain is served, and gets a certificate, only while its page is **active**, hosted from a ZIP, and has a live
  version (`public.lp_served_hosts()`). Removing the domain or deactivating the page removes its host directory
  right away (and every 5 minutes the admin app re-checks all links), so it stops being served even though Caddy
  may still hold the certificate.
- The last 5 versions are kept. **Make live** on an older one rolls back (audited `lp_version.activate`). Old versions
  are deleted only after the domains were re-linked, and never one that a host link still points at.
- **Stop hosting (back to external)** switches the page to an external one (audited `lp_hosting.stop`): its domains
  stop serving the ZIP and lose their certificate approval at once; the versions stay, and **Make live** hosts it again.
- Failed re-links are retried every 5 minutes; three in a row raise an alert. The internal process retries a failed
  reload of its host list after 5 s, doubling to 1 min, and raises an alert after three failures in a row; meanwhile it
  approves no new certificate (fail closed).
- Headers on LP hosts (infra/caddy/Caddyfile): HSTS, `nosniff`, a fixed Content-Type per extension
  (`charset=utf-8` on text), and this default CSP for pages:
  - scripts from the page itself (inline included), `https://api.<DOMAIN>` (SDK, Cap), `'wasm-unsafe-eval'`
    (the Cap solver), `connect.facebook.net`, `analytics.tiktok.com`, `www.googletagmanager.com`;
  - requests only to the page, the API and the pixel vendors' report hosts; images from any https origin;
    fonts from the page and Google Fonts; YouTube embeds;
  - `worker-src blob:` (Cap), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`.

  A page that needs more (another CDN, another embed) must be changed to self-host it. A page may add its own
  stricter CSP. SVG files get `Content-Security-Policy: sandbox`. A folder path serves its `index.html` only.

  The CSP does **not** contain the page's author: inline scripts are allowed, so the author's own code can do
  anything a script on that origin can (read the checkout form, call any allowed host). It bounds what third-party
  content the page can pull in and where requests can go; the author is trusted as the Owner's choice.

## Residual risk (accepted)

- Caddy follows symlinks under `/srv/lp`. The admin app is the only writer there and never creates a link inside a
  version, but a compromised admin app could plant a link to Caddy's own files (its TLS keys under `/data`) and have
  Caddy serve them on an LP host. Accepted for v1: the admin app is behind the IP allowlist and forced 2FA, holds no
  private key, and the files are only reachable on an approved LP host (security review US-023 L4).

## Staging check (criterion 3, VM only)

Needs the staging VM, a custom domain whose DNS you control, and the Owner signed in to the console.

1. Point an A (and AAAA, if the VM has IPv6) record of a test name, for example `lp-test.<your-domain>`, at the
   VM. Optionally point a second name, `lp-unregistered.<your-domain>`, at the VM too and register it nowhere.
2. In the console, create a landing page (or use one), make it **active**, and register `lp-test.<your-domain>`.
3. Upload a valid ZIP (any small site with `index.html`, for example `e2e` fixtures or a hand-made one) and wait for
   "Version 1 is live".
4. On the VM, from the checkout:

   ```sh
   sudo infra/verify/lp-tls-check.sh lp-test.<your-domain> <lp_key> lp-unregistered.<your-domain>
   ```

   It must end with `summary: N passed, 0 failed`. It checks: the host is in `lp_served_hosts()`, the ask approves
   it, `current` is a symlink to the live version; `https://` answers 200 over a publicly trusted certificate whose
   SAN names the host; the page holds the injected SDK tag, with the fixed Content-Type, nosniff, HSTS and the
   default CSP; a `.php` path is a 404; `http://` redirects; none of `play`, `order`, `api`, `admin` serves the LP;
   and the unregistered name is refused by the ask and gets no certificate.
5. Upload a second ZIP and run the check again (the link moved); press **Make live** on version 1 and run it again.
6. Deactivate the page: `https://lp-test.<your-domain>/` must answer 404 within seconds; reactivate it.

## Local checks

- `pnpm test` (uploads: `lp-zip`, `svg`, `lp-html`; `infra/verify/src/caddyfile.test.ts`), the db, worker and admin
  integration suites (`lp-hosting.int.test.ts`, `domains.int.test.ts`, `lp-domains-notify.int.test.ts`).
- `infra/verify/local/lp-headers.sh` runs the LP site of the real Caddyfile in Caddy 2.11.9 (Docker) with real
  Linux symlinks: Content-Types, CSP, refusals, and no failed request during 100 atomic swaps of `current`.
- On Windows the admin tests use junctions instead of symlinks (no privilege for symlinks), and the swap there is
  unlink + rename; the atomic rename is a Linux property, covered by `lp-headers.sh` and the staging check.
