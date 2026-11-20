# @ebooktrivia/sdk: the landing-page SDK (US-019, M6a)

One small script (under 15 KB gzipped, about 9 KB) that turns any custom HTML page, hosted anywhere, into a tracked checkout:
it captures the ad click, binds to the page's own form, solves the Cap check, creates the order and the Midtrans payment through the
public API, fires the browser pixel once, and redirects to the Midtrans Snap page.

```html
<script src="https://api.<DOMAIN>/sdk/v1.js" data-lp="lp_..." async></script>
```

The admin console prints this snippet for each landing page (`apps/admin/src/lib/settings/landing-pages.ts`). The ZIP hosting
story (US-023) injects the same tag. The SDK only runs from an https API origin (plain http on loopback is for a developer's
machine and the tests), and only recognises its own tag: the executing script, else a `data-lp` tag whose path is exactly
`/sdk/v1.js` or `/sdk/sdk-vX.Y.Z.js`.

## The form: data attributes

The LP author writes the HTML. The SDK finds every `<form data-ebt-checkout>` and binds to it.

```html
<form data-ebt-checkout method="post">
  <label for="n">Nama lengkap</label>   <input id="n" data-ebt-field="name" autocomplete="name">
  <label for="p">Nomor WhatsApp</label> <input id="p" data-ebt-field="phone" inputmode="tel" autocomplete="tel">
  <label for="e">E-mail</label>         <input id="e" data-ebt-field="email" type="email" autocomplete="email">
  <label><input type="checkbox" data-ebt-consent> <span data-ebt-consent-label></span></label>
  <button type="submit" disabled>Beli sekarang</button>
</form>
```

| Attribute | Required | Meaning |
|---|---|---|
| `data-ebt-checkout` on a `<form>` | yes | The SDK takes over its `submit`. It sets `novalidate`, so its Bahasa Indonesia messages replace the browser's |
| `method="post"` on the form and `disabled` on the submit button | yes | **Until the SDK has bound, nothing can be submitted natively**: the button is disabled in the HTML, and a form without a method would submit with GET and put the buyer's name, phone and e-mail in the URL. The SDK enables the submit buttons of a form when it binds. If the script never loads, the button stays disabled and the buyer cannot send anything to the page by accident |
| `data-ebt-field="name\|phone\|email"` | yes, all three | The inputs. The phone is normalised to E.164 (`08...`, `+62...`, `62...`) |
| `data-ebt-consent` on a checkbox | yes | The UU PDP consent (AC-A10). Unchecked blocks the submit |
| `data-ebt-consent-label` | no | Where the SDK writes "Saya menyetujui Syarat & Ketentuan dan Kebijakan Privasi.", both linked (new tab) to `play.<DOMAIN>/legal/{program}/{kind}/{version}`, the newest published versions. Left out, the SDK adds the span after the checkbox's label |
| `data-ebt-error="name\|phone\|email\|consent"` | no | Where that field's error goes. Left out, the SDK adds a `<p class="ebt-error">` after the field (after its `<label>` when it sits inside one, so the error does not become part of the label) |
| `data-ebt-status` | no | The polite live region for "Memproses pesanan...". Left out, the SDK adds `<p class="ebt-status">` at the end of the form |

A form with no consent checkbox, or without all three fields, cannot take orders: it says so instead of failing silently. So does a page
whose config cannot be loaded, whose checkout is closed (inactive, sales over, no published legal pages), or whose consent links would
not lead to the program's own legal pages: no order is taken unless the buyer can read what they consent to.

While a submit is in flight the submit buttons are `disabled`, the form has `aria-busy="true"` and the status region says so; a second
submit event (double click, Enter twice, `requestSubmit()`) is ignored, so one click can never create two orders. After an error
everything is enabled again. Back from the payment page (bfcache) the form is usable again, unless the vendor pixel libraries had been loaded in that page: then the
page is reloaded, so nothing is retyped under live vendor scripts.

Accessibility of what the SDK injects: errors are text (never colour alone), sit next to their field and are linked with
`aria-describedby` plus `aria-invalid="true"`; the first invalid field is focused; progress is a polite live region; a form-level
error is `role="alert"`; the disabled button gets focus back if nothing else took it. Default styles are `:where()` rules in a
constructable stylesheet (allowed under a strict `style-src`), error text `#b91c1c` (6.5:1 on white), and any CSS of the page overrides
them. The classes are `ebt-error`, `ebt-form-error` and `ebt-status`.

## What the page's CSP must allow

An LP with a Content-Security-Policy needs, for `https://api.<DOMAIN>` (the API origin):

```
script-src  https://api.<DOMAIN> 'wasm-unsafe-eval'
connect-src https://api.<DOMAIN>
worker-src  blob:
```

`script-src` for the SDK and the Cap widget; `connect-src` for the API and for the Cap widget's `fetch` of its WebAssembly; `worker-src
blob:` because Cap solves in web workers; `'wasm-unsafe-eval'` so the browser may compile the solver. **Without `'wasm-unsafe-eval'` the
checkout still works**: the widget cannot compile the module, says so on the console, and solves in plain JavaScript (slower, same
result). With a pixel registered, add the vendor's script host (`connect.facebook.net`, `analytics.tiktok.com`,
`www.googletagmanager.com`) to `script-src` and what the vendor documents for `connect-src` / `img-src`. The SDK uses no inline script,
no eval and no inline style. The only console noise on a page with a strict `style-src` is one error from the Cap widget's hidden
element applying an inline style (blocked, never visible).

## Attribution (AC-T1)

- **Captured from the landing URL**, allowlisted names only: the adnet's own click-id parameter (the `clickid_param` of each adnet
  allowed on the page, from the config), `sub_id`, `pub`, `utm_source|medium|campaign|content|term`, `fbclid`, `ttclid`, `gclid`.
  `adnet=<slug>` picks the adnet when several share a parameter name; the slug itself always comes from the config. Cookies: `_fbp`
  and `_fbc` (built as `fb.1.<click ms>.<fbclid>` when only `fbclid` is known), read fresh at every request.
- **Limits** (`SDK_LIMITS`): a click id, `sub_id` and `pub` 256 characters, `fbclid`, `ttclid` and `gclid` 512, a UTM value 256. Ids are
  printable ASCII without spaces; a UTM value may hold any text but control, format (bidi) and private-use characters. A value that is
  too long or malformed is dropped, the rest is kept. **The API does the same: it drops a malformed or too-long attribution value (and an
  unknown key, or an adnet that is not allowed for the page) and never rejects a checkout for it**; such an order counts as organic.
- **Which visit replaces the stored click.** Only a **new ad click id** does: the adnet's click id, `fbclid`, `ttclid` or `gclid`. It replaces
  the stored record whole (an old `sub_id` never rides along with a new click id), with the URL's `sub_id`, `pub` and UTM travelling with it.
  Anything else leaves the stored click untouched: a plain revisit, or a visit with only UTM or only `sub_id` / `pub`.
  `?cid=AFF123` and later `?utm_source=newsletter` keeps `cid`, and sends no newsletter UTM with it. When nothing is stored yet, such a
  visit's parameters are kept once (first touch), so an organic buyer's UTM still reaches the order; later UTM-only visits do not replace
  it, and an ad click id does. The same click opened again (a reload of the landing URL) keeps its first time and is not written again, so reloading
  never stretches the 30 days: a click is "the same" when every key the URL carries is already stored with the same value (the stored
  record may hold more, such as the adnet's click id resolved on the first load, so a reload of `?cid=AFF1&gclid=G1` before the config
  arrives still has `cid`).
- **Stored** in `localStorage` under `ebt:attr:1:<lp_key>` as `{v, t, a}` for **30 days from the click**; expiry is checked on read
  (`now - t >= 30 days` removes it) and the clock is injectable (`AttributionDeps.now`).
- **Two capture phases.** The adnet's click-id parameter is only known once the config has arrived, and the visitor may leave first. So at
  boot (no network) the fixed keys are captured (`fbclid`, `ttclid`, `gclid`, UTM, `sub_id`, `pub`) and stored, and the URL's other
  parameters wait in **`sessionStorage`** (`ebt:cand:1:<lp_key>`: at most the last 3 loads of the tab, each at most 6 parameters and 2 KB,
  30 minutes) until the config arrives and the adnet's click id is resolved; then the whole record is deleted (so is a record that is expired or
  malformed, as soon as it is read). If the config never arrives, a later load in the same tab resolves them, oldest first, so the newest click
  wins; a later load never overwrites an earlier unresolved click, and a first-touch UTM stored since does not outrank it (only a stored ad
  click id that is newer than the parked one does).
- **What may wait in sessionStorage.** The point is to park click ids, not personal data. The last config's click-id parameter names
  (`clickid_param`, not personal) are cached in `localStorage` (`ebt:names:1:<lp_key>`, 30 days). Once an earlier load has learned them,
  **only a parameter with one of those names is parked**. On a first visit, when the names are not known yet, a parameter is parked only if its
  name has none of these as a whole word (delimited by `_`, `.`, `-` or the ends of the name, case-insensitive; the same pattern as above): phone,
  hp, wa, whatsapp, nama, name, email, mail, token, otp, kode, nik, ktp, card, kartu, pass, password, pwd, secret, auth, session, and its value is token-shaped, has no `@`, has no run of 8 to 16 digits once
  separators are removed, and is not a phone number the Indonesian normaliser accepts. That fallback is a filter, not a guarantee: a
  personal value under an unlisted name could be parked, for as long as it takes the config to arrive (usually milliseconds), 30 minutes
  at most, or until the tab closes. Its price: on a first visit a click id that is a plain run of 8 to 16 digits is not parked (it is still
  captured when the config arrives on that load).
- **A contact detail is never a click id.** An adnet's click-id parameter name is admin-configured. The console refuses a name that has a
  personal-data word as a whole word, delimited by `_`, `.`, `-` or the ends of the name (phone, hp, wa, whatsapp, nama, name, email, mail,
  token, otp, kode, nik, ktp, card, kartu, pass, password, pwd, secret, auth, session; `SDK_PATTERNS.personalParamName`; `no_hp` and
  `session_id` are refused, `swap_id` and `hpid` are not), and `adnets.clickid_param` has the same CHECK (migration 0010). The SDK does not rely on that: on
  every path (parsing the URL, the cached names, resolving a parked entry, reading the stored record) a value that contains `@` or that the
  Indonesian phone normaliser accepts is dropped from the click id, so it is never stored, sent to the API or put in an adnet postback, and the
  next adnet's parameter is tried. The 8-to-16-digit rule stays a first-visit rule, because some adnets use numeric click ids.
- **Hostile input.** The URL and the stored records are untrusted: unknown keys, wrong types, a future `t`, an over-long record, invalid
  JSON and a blocked or full store all end as "no stored click" without an exception. Beyond the click record, the cached parameter names and the
  parked candidates, only the list of already-fired event ids is ever written to storage. **No name, phone number or e-mail is ever stored** (no cookies
  written).

## Wire contract

Types, pattern sources and limits: `packages/core/src/sdk-contract.ts` (`@ebooktrivia/core/sdk-contract`, no runtime logic). The
SDK, the API and the admin console's pixel check all import the same `SDK_PATTERNS` and `SDK_LIMITS`. The checkout API (US-020), the visit
and config endpoints (US-024) and the Cap routes (US-020) implement exactly this. All bodies are JSON with snake_case fields and
`"v": 1`. `visit_id` and `event_id` are **lowercase UUIDs** (`SDK_PATTERNS.uuid`); the SDK ignores any other shape. Every request is
`credentials: "omit"` (no cookie is ever sent to `api.<DOMAIN>`), `mode: "cors"`, `redirect: "error"`, with a 30 s timeout.

**CORS and Origin.** The `Origin` must equal an origin registered for the landing page, which is always `https://` plus a host of
`lp_domains` (the console registers bare hosts only). Only then does the API answer with `Access-Control-Allow-Origin: <that origin>` and
`Vary: Origin` (never `*`, never `Allow-Credentials`); the preflight answers `Access-Control-Allow-Headers: content-type, accept`. Any other
origin gets no CORS headers (the browser reports a network error). The static files under `/sdk/` are different: public, no credentials,
`Access-Control-Allow-Origin: *` (Caddy, see Hosting).

| Route (relative to `https://api.<DOMAIN>`) | Request | Response |
|---|---|---|
| `GET /api/v1/lp/{lp_key}/config` | none | `SdkLpConfig`, `Cache-Control: public, max-age=60`: `checkout_open`, `adnets[{slug, clickid_param}]`, `pixels{meta?, tiktok?, gtag?}`, `midtrans_env` (`sandbox` or `production`), `legal{play_origin, program, terms, privacy}` or `null` |
| `POST /api/v1/visit/{lp_key}` | `{v, attribution}` (the visit beacon, once per page load after the config, `keepalive`, fire and forget) | 200 `{v, visit_id}`, or 204 with no body. Any other status, a timeout or a network failure is ignored: the SDK never blocks the page, never retries, and the checkout then carries no `visit_id` |
| `POST /api/v1/cap/{lp_key}/challenge` and `/redeem` | the Cap widget protocol (`@cap.js/widget` 0.1.62 against `@cap.js/server` 4.0.5; the `CapProvider` of packages/adapters: `challenge()`, `redeem({token, solutions})`) | Cap's |
| `POST /api/v1/checkout/{lp_key}` | `{v, name, phone, email, cap_token, consent{terms, privacy}, attribution, visit_id?}` | 200 `{v, event_id, snap_redirect_url, value_idr, deduped}` |

Checkout errors: `{v, error, fields?}` with `error` one of `validation` (400, with `fields` of `name: required|too_long`,
`phone: empty|invalid_characters|not_indonesian|not_mobile|invalid_length` (the core `PhoneError`), `email: required|invalid`,
`consent: required|outdated`), `captcha` (403: missing, invalid or reused token), `origin` (403), `sales_closed` (409), `rate_limited`
(429), `gateway` (502, Snap failed; the same phone may retry), `unavailable` (503). A body that does not parse falls back to the HTTP
status (429, 403, 409, 400, else unavailable).

Rules for the server side:

- The price is never sent; `value_idr` is the server's, for the pixel.
- `consent` carries the **policy versions** the buyer accepted (the SDK sends the versions from the config it read). The API
  checks them against the newest published versions and answers `consent: outdated` if a newer one exists, and stores them with the
  order (AC-A10).
- `event_id` is the order's `orders.event_id`. For a reused open order (the same buyer on the landing page within 30 minutes, AC-T8: the
  same phone AND name AND e-mail, compared trimmed, NFC, whitespace collapsed and lowercased; Owner decision D1, US-020) the
  response carries the same `event_id`, the stored `snap_redirect_url` and `deduped: true`: the SDK fires no pixel for it.
- `snap_redirect_url` must be an https URL on the Snap host of `midtrans_env` with a Snap payment page path; the SDK refuses anything else.
- A Cap token is single use (the API marks it with the `ReplayStore`) and valid only for the landing page it was solved for, so after
  any answer the SDK solves a fresh one.
- The SDK validates every response by hand (shape, types, lowercase-UUID `event_id`, integer `value_idr`, pixel ids in each vendor's format);
  a body that is not the contract's is "unavailable".

## Cap (AC-S3)

Cap is not in the bundle (the widget is about 56 KB). It is self-hosted next to the SDK as `cap-v0.1.62.js` (an unmodified copy of
`@cap.js/widget`'s `cap.min.js`) and **loaded on the visitor's first interaction with the checkout form** (first `focusin` inside a
`data-ebt-checkout` form), not at submit: loading it at submit would make the buyer wait for the script, a challenge and the proof of work
after clicking, while loading on first focus lets the proof of work run in the workers while they type, so the token is usually ready
at submit. A page that is only read never loads it, never asks for a challenge and never starts a worker. If the token is not ready at
submit the form shows the loading state until it is.

- **Used headless** (`new Cap({apiEndpoint: <api>/api/v1/cap/<lp_key>/})`), with the SDK's own `fetch` (no cookies).
- **WebAssembly, self-hosted.** The widget's solver is `cap-wasm-v0.0.8.wasm` (`@cap.js/wasm` 0.0.8, SHA-256 proof of work, the
  algorithm `@cap.js/server` 4.0.5 issues). `cap-hashwx-v0.0.8.wasm` is the solver of the `hashwx` challenge protocol that newer Cap servers
  can issue; this server never does, so it is not fetched today, and is there only so that nothing can ever fall back to the widget's default
  CDN. Both are unmodified copies named after the package version (immutable), outside the 15 KB budget, fetched from `api.<DOMAIN>` (so the
  `connect-src` above, and CORS on `/sdk/`). The widget fetches the module at load; if the browser refuses to compile it (no
  `'wasm-unsafe-eval'`) or the fetch fails, it logs one warning and solves in JavaScript.
- **No server-supplied code runs.** A Cap server can ask the widget to run an "instrumentation" script in an iframe. `@cap.js/server`
  4.0.5 never does, and the SDK keeps it off: `CAP_ISOLATE = true` (such a frame would be sandboxed without same-origin access) and
  `CAP_PAKO_URL = "data:,"` (the CDN inflater that script needs is never fetched). `e2e/tests/sdk.spec.ts` checks the page has no iframe.
- **A token goes stale.** The API's Cap is stateless (US-020): a challenge (172 hex characters) and a redeemed token (146) are signed by
  the server and bound to the landing page; a token expires 10 minutes after its challenge does, so it is good for at least 10 minutes
  after its redeem (`SDK_CAP.tokenMinLifetimeMs`). A token the SDK has held for 8 minutes or more (10 minus a 2 minute margin, on this
  device's clock) is not used: a fresh one is solved before the submit goes out.

## Pixels (AC-T5)

The MO event is `InitiateCheckout` (Meta `fbq('trackSingle', id, 'InitiateCheckout', {value, currency: 'IDR'}, {eventID})`, TikTok
`ttq.instance(id).track('InitiateCheckout', {...}, {event_id})`, Google `gtag('event', 'begin_checkout', {send_to, value, currency})`), with
the `event_id` the server returned, so the server-side conversion (CAPI, TikTok Events API) dedupes against it. The Google event is
a plain `begin_checkout`: the Ads conversion label belongs to the MT Purchase on the order page.

- **Nothing loads before the order exists.** No vendor script runs on a visitor who has not ticked the consent box, none while the
  checkout request is in flight, and none if the order fails or is deduped. After a successful, valid response the SDK first **empties the
  form's name, phone and e-mail inputs**, then loads the vendor scripts and fires: the vendors' automatic advanced matching scrapes e-mail
  and phone fields from the DOM, so by then there is nothing to read. A blocked or slow vendor is waited for at most 2.5 s and never blocks
  the payment.
- **Automatic advanced matching.** Meta: switched off, `fbq('set', 'autoConfig', false, id)` before `init`. TikTok: **no client-side
  switch exists** (its loader takes the pixel's plugin configuration, including `AutoAdvancedMatching`, from the account), so turning it
  off is an Owner step in TikTok Events Manager: `docs/runbooks/landing-page-pixels.md`. Google: no automatic matching is requested.
- **The registered id gets the event.** If the page already runs a vendor's own base code, the SDK uses it instead of loading a second
  copy, but still `init`s / loads the registered id when the page did not, and addresses the event to that id only (`trackSingle`,
  `instance(id)`).
- Each event id fires **at most once**: it is claimed in memory and in `localStorage` (`ebt:fired:1`, the last 20 random ids, nothing
  personal) before anything is sent, so a reload or a return from the payment page cannot fire it twice. A `deduped` order fires nothing.
- The browser pixel for MT (Purchase) is fired on the order page (`order.<DOMAIN>`, M6.6), not here.

## What the page must not do

The SDK can clear and control only what it owns. The landing page must therefore:

- **Not ship its own Meta or TikTok base code** (`fbq`, `ttq`) on the checkout page. A vendor library that is already running cannot be
  switched to "no automatic advanced matching" by the SDK: its `autoConfig false` comes too late for a pixel the page has already
  initialised, and the page's own copy may have scraped the form before the SDK emptied it. Register the pixel ids in the console and let the
  SDK load the libraries after the order exists. (If a page does run its own base code, the SDK still sends the event to the registered id, but
  it cannot vouch for what that library read.)
- **Have no personal-data input outside the `data-ebt-checkout` form** (a second e-mail or phone field in a newsletter box or a footer): the
  SDK empties the name, phone, e-mail and any `type="email"` / `type="tel"` input **of that form only**, so a field elsewhere on the page is
  still there for a vendor script to read.
- Keep the form's `method="post"` and the `disabled` submit button (above).

## The redirect guard

`snap_redirect_url` is the only server-supplied URL the SDK navigates to. It must parse as `https:` on exactly `app.sandbox.midtrans.com`
(`midtrans_env: "sandbox"`) or `app.midtrans.com` (`"production"`), no port, no user info, **no query and no fragment, and a path of the
Snap payment page shape** `/snap/v<N>/(redirection|vtweb)/<token>` with a token of letters, digits and hyphens (Midtrans' documentation
shows `/snap/v2/vtweb/{token}` and `/snap/v3/redirection/{snap_token}`; the sandbox returns `/snap/v4/redirection/{token}`; any version
number is accepted; **the strict path and the no-query rule must be confirmed against the real sandbox in US-005 before production**: a real
Snap URL this refuses would turn every payment into the error state). The SDK navigates to the parsed form, never the raw string. Anything
else shows "Alamat pembayaran tidak dikenali, jadi kamu tidak dialihkan. Hubungi penyelenggara.", fires no pixel and leaves the form
usable.

## Other rules the code keeps (and tests pin)

- No `eval`, `new Function`, `document.write`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `importScripts` or string timers in the
  bundle (`build.test.ts` greps the output). Everything injected is `createElement` + `textContent`.
- The bundle names no host except the three pixel vendors' script hosts (`build.test.ts`).
- Storage writes live in two files only (`attribution.ts`, `pixels.ts`); no cookie is written.
- The browser's phone and e-mail checks are for feedback; the server stays the authority (AC-S4).
- A failure never reaches the host page as an exception: the whole boot is wrapped, and a form the SDK could not set up behaves
  as the page made it (with a disabled button, see above).

## Build, release and hosting

`pnpm --filter @ebooktrivia/sdk run build` writes `dist/`:

| File | Cache (Caddy, `api.<DOMAIN>/sdk/`) | |
|---|---|---|
| `sdk-v1.0.0.js` | `public, max-age=31536000, immutable` | the SDK, named after `package.json`'s version. **Bump the version for every change**: a published versioned file is never overwritten (`build-images.sh sdk` refuses a changed file with the same name) |
| `v1.js` | `public, max-age=300` | the alias the snippet uses; a byte-for-byte copy of the newest `v1.x.y`. A new release reaches pages within 5 minutes |
| `cap-v0.1.62.js` | `public, max-age=31536000, immutable` | the Cap widget, named after its version |
| `cap-wasm-v0.0.8.wasm`, `cap-hashwx-v0.0.8.wasm` | `public, max-age=31536000, immutable` | the widget's WebAssembly solvers (`@cap.js/wasm`), `Content-Type: application/wasm` |

Every file under `/sdk/` also carries `Access-Control-Allow-Origin: *` (a page on another origin `fetch`es the wasm) and
`Cross-Origin-Resource-Policy: cross-origin` (a COEP page can embed the script). Hosting without a CDN: the `sdk` stage of
`infra/images/app/Containerfile` builds the files; `sudo infra/provision/build-images.sh sdk` copies them to `/srv/sdk` (older versions stay;
its scratch directory is removed on every way out), which the Caddy container mounts read-only; `infra/caddy/Caddyfile` serves them at
`api.<DOMAIN>/sdk/`. The cache header is only added to a file that exists, so a 404 for a version that is not deployed yet is never
cached as immutable (`infra/verify/local/sdk-headers.sh` checks all of this against a real Caddy). A breaking change ships as `/api/v2`
and `v2.js`; `v1.js` keeps speaking v1.

esbuild 0.28.2, one minified IIFE, ES2020, ASCII output; the build fails on any esbuild warning. Linux and Windows builds are
byte-identical.

## Tests

- `src/*.test.ts` (root `pnpm test`): attribution (which visit replaces the click, the two phases, the parked candidates, 30-day expiry with an
  injected clock, corrupted and blocked storage, no personal data stored); the redirect guard; validation and messages; the API client
  (no credentials, response checks, error mapping); the pixels (once per order, AAM off, `trackSingle` / `instance`, never blocking); the Cap
  loader (self-hosted wasm, isolation flags, token age); `flow.ts` (order of events, every not-ready state, consent, error mapping, the
  one-order-at-a-time guard); `boot.ts` (script and origin checks, capture at boot); the build (immutable file, alias, widget and wasm
  copies, gzip size budget, forbidden constructs, no third-party host).
- `e2e/tests/sdk.spec.ts` (`pnpm --filter @ebooktrivia/e2e test:sdk`, and part of the main Playwright run in CI): fixture landing pages on
  another origin under a strict CSP (with and without `'wasm-unsafe-eval'`, and without the script), a stub API that implements the contract
  and answers Cap with the real `@cap.js/server`; the Meta library and the Midtrans Snap page are intercepted. The form's DOM behaviour
  (error placement, aria, focus) is covered there, not by unit tests, since no DOM implementation is installed.
