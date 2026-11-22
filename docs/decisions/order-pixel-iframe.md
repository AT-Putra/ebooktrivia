# Decision: keep the order pixels in the order page, not in a sandboxed iframe (US-031 follow-up)

Status: **recommended, not built** (2026-11-22). The residual stays accepted (docs/runbooks/order-status-page.md, "Residual
exposure to the third-party scripts"). Revisit when a trigger below fires.

## The question

The order status page (`order.<DOMAIN>`) runs the landing page's Meta, TikTok and Google tags in its own document, so a vendor
library can read what the page's script can: the order's public id (in `sessionStorage` and the page data), the order code and the
masked buyer. Should the tags run in a sandboxed iframe on a separate origin that receives only the event values?

## What an attacker controlling a vendor script gains today

- The order's public id: read-only status of that order (masked name and phone, product, amount; never an e-mail or a raw
  phone), and, within one hour of payment, the single browser-conversion claim (`claim_browser_mt`), which fires the same
  `event_id` the server-side conversion carries, so a duplicate is dropped by the vendor. No login, no delivery, no money.
- Nothing else: the origin has no cookies in either direction (Caddy strips them), its CSP lets only that page's vendors load
  and report (lib/order/csp.ts), Referrer-Policy is `strict-origin`, the address is stripped before the tags load, and the
  lookups are rate-limited per IP.

## What the iframe would cost

- **Attribution.** A sandboxed iframe without `allow-same-origin` has an opaque origin: `document.cookie` and `localStorage`
  throw, which the Meta and TikTok libraries use for `_fbp` / `ttp`; with `allow-same-origin` on a separate origin it is a
  third-party frame whose storage browsers partition or block. Either way the browser event loses the identifiers that make it
  worth sending, and Google's tag would need its own consent and cookie handling there.
- **Another origin** (DNS name, certificate, Caddy site, CSP, a postMessage contract with origin checks both ways) and a new
  class of bugs (a message spoofed into the frame fires a conversion).
- The server-side conversions (US-024: Meta CAPI, TikTok Events API, adnet postbacks) already carry the conversion with the same
  `event_id`; the browser event is the secondary signal.

## Recommendation

Do not build it for v1: the data within reach is masked and read-only, and the cost lands on the funnel's measurement. Two cheap
hardenings remain possible without an iframe and are recorded as follow-ups: keep the public id out of the server-rendered page
data once the script holds it, and clear `sessionStorage` when the status is final (paid or refunded).

## Triggers to revisit

- the order page starts showing anything unmasked, or the public id gains a write beyond the one claim;
- a vendor library is reported to read `sessionStorage` or exfiltrate page data;
- the browser events stop mattering for attribution (all vendors on server-side conversions only), which removes the cost.
