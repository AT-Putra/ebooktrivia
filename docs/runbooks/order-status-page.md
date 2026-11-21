# Order status page (`order.<DOMAIN>`): Owner and staging steps

The page a buyer lands on after paying (US-022). It runs the landing page's Meta, TikTok and Google Ads pixels for the **MT** (paid) event, so
it is the one place vendor scripts run next to buyer data. The rules it keeps: no cookies (Caddy strips them both ways), no login token, the
order id removed from the address before any vendor script exists, only masked personal data, one browser Purchase per order.

## Midtrans dashboard (once per environment)

The Snap request sets only the **finish** URL, per order: `https://order.<DOMAIN>/{publicId}`. The dashboard's **unfinish** and **error**
redirect URLs are one static URL each and cannot carry an order, so set both (and finish, as a fallback) to:

```
https://order.<DOMAIN>/
```

Midtrans appends `?order_id={publicId}-{n}&status_code=...&transaction_status=...` to it. The proxy (`apps/public/src/proxy.ts`) serves
`/?order_id={publicId}-{n}` as that order's page; every other query value is ignored (the page shows the database's status, never what the
redirect claims).

## What the page shows

- The order code, the product, the amount, the status, and the buyer's name and phone **masked by the product's one masking rule**
  (`public.mask_name` / `public.mask_phone`, also used by the winners banner: "B*** S***", "****890"). The database function behind the page
  (`get_order_status`) returns only the masked values, so a raw name or phone never exists in the app process. No e-mail at all.
- The status is polled: every 3 s at first, slower after 30 s, at most every 30 s, for at most an hour (then a button offers a manual
  check). It stops at **paid** and **refunded** only. An order that looks expired, failed or under review can still be paid late (a virtual
  account paid after the page gave up: the order machine moves any non-paid, non-refunded order to paid on a confirmed settlement), so
  those states keep being asked at 30 s within the hour.

## What the page fires, and how once

- Meta `Purchase`, TikTok `CompletePayment` (TikTok's purchase event; its Events API uses the same name), Google Ads `conversion` with
  `send_to = AW-id/label` and `transaction_id`.
- `event_id = orders.event_id` and `transaction_id = orders.id`: the same values the server-side conversions (US-021 writes them; US-024
  sends them) carry, so Meta and TikTok drop the second copy of the event. The server-side event must use the same event names.
- Once: the page asks the database for a claim (`claim_browser_mt`: one conditional `UPDATE` of `orders.browser_mt_fired_at`, only for a PAID
  order that is not claimed). Only the call that wins gets the pixel ids and fires. A reload, a second tab or a retry gets nothing. A claimer
  that never fires (the tab closed first) is not retried: the server-side event covers it.
- **The claim is a bearer action.** Whoever holds the order's public id can make it (the id is the page's capability), so it expires **one
  hour after payment**: a visitor after that gets nothing, and the server-side conversion covers the order. Residual: within that hour a
  holder of the id other than the buyer (a link forwarded, a screenshot of the address bar before the page stripped it) can win the claim
  and fire the browser event from their own browser. The event carries the order's own `event_id` and no personal data, so the worst case
  is that the browser event comes from the wrong browser (attribution cookies of that browser), never a duplicate or an exposure of data.

## Residual exposure to the third-party scripts (accepted for v1)

The vendor libraries run in the page's origin, so they can read what the page's own script can: the order id the script keeps in
`sessionStorage` (`ebt:order:1`, for polling and for a reload) and the server-rendered page data (the order code, the masked buyer, and
the order id in the page's own flight data). The address is stripped before they load and Referrer-Policy is `strict-origin`, but a
library that reads `sessionStorage` or the document can still see the id. A vendor script that did could fire a claim of its own within
the hour (above). Not done in v1: running the vendors in a sandboxed iframe on a separate origin that receives only the event values
(US-031, hardening, follow-up).

## Access logs

The order site's Caddy access log (`order_access_log` in `infra/caddy/Caddyfile`) never holds the public id: a page request is logged as
`/[order]` (`/order/{publicId}` too), the Midtrans `order_id` query value as `[redacted]`, and the Referer header is not written. Next 16
also reports the proxy's rewrite to the client in `x-middleware-rewrite: /order/{publicId}` (and, for RSC requests,
`x-nextjs-rewritten-path` / `-query`): the order site removes those from the response and leaves them out of its log, so the id is in
neither. The error log (`log default`) is not covered: an upstream error on the order host would still name the path.
`infra/verify/local/order-headers.sh` checks the real Caddy on all of this.

## Serving it: the production entry

`apps/public/next.config.ts` sets `skipProxyUrlNormalize: true`. Without it the proxy's request URL has the host `localhost` while the
container's server (`src/server.ts`, bound to `EDGE_HOST`) resolves a rewrite against its own address, so every proxy rewrite of
`order.<DOMAIN>/` and `/{publicId}` looked external and answered an empty 404 (a plain `next start` hid it). The e2e now starts the
app through `src/server.ts` with an explicit `EDGE_HOST`, as the container does.

## Checks on staging (plan M6 Verify)

1. Pay a sandbox order from an external landing page; on `order.<DOMAIN>` the vendor's test-events tool shows ONE event per order with the
   order's `event_id`, and no e-mail or phone parameters. Reload and open a second tab: still one.
2. Response headers of `https://order.<DOMAIN>/{publicId}`: exactly one `Referrer-Policy: strict-origin`, `Content-Security-Policy`
   listing only the vendors that landing page has pixel ids for, a nonce, no `unsafe-inline` or `unsafe-eval` in `script-src`, no
   `Set-Cookie`.
3. The browser console shows no CSP violation from Meta or TikTok while their scripts run. **Google may log a blocked script or frame**
   (gtag.js can try to load a secondary script from `www.google.com` or `www.googleadservices.com`, or a frame): expected. Only
   `www.googletagmanager.com` may serve scripts (`script-src`), and `frame-src` is `'none'`, on purpose: those hosts serve many scripts, so
   allowing them would let any of them run on a page with buyer data. The conversion itself is a request (`img-src` / `connect-src` allow
   Google's hosts): confirm in Google Ads that the conversion arrives. The vendor host lists are in `apps/public/src/lib/order/csp.ts`
   (Google's from its Google Ads CSP guide; Meta's and TikTok's from the hosts their libraries load from and report to). If a vendor adds a
   host for a request, a violation names it; add it there, per vendor and per directive.
4. TikTok: automatic advanced matching stays off in Events Manager (`docs/runbooks/landing-page-pixels.md`).
5. An order that was never paid expires; let one expire, pay it late through the sandbox simulator, and watch the open page change to
   "Pembayaran berhasil" within a minute.
