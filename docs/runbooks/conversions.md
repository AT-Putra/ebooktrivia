# Conversions (S2S postbacks, Meta CAPI, TikTok Events API): Owner and operator notes

US-024 (M7). What goes out, what it needs, and what is still unverified because no real credential exists yet (US-005).

## What is sent

| Sink | MO (order created, Snap exists) | MT (order PAID) | Refund |
|---|---|---|---|
| Adnet S2S (attributed orders only) | the adnet's MO template, `{status}` = `pending`, `{payout}` = `0` | the MT template, `{status}` = `approved`, `{payout}` = the adnet's payout | the reversal template, `{status}` = `reversed`, only when the MT reached the adnet |
| Meta Conversions API (page has a Meta pixel) | `InitiateCheckout` | `Purchase` | none (Meta has no standard refund event) |
| TikTok Events API (page has a TikTok pixel) | `InitiateCheckout` | `CompletePayment` | none |
| Google Ads | browser only (`gtag`, order page) | browser only | none |

- `{txid}` is `orders.id`, the same for every attempt and every sink, so an adnet can dedupe. The Meta / TikTok `event_id` is `orders.event_id`,
  the same id the browser pixel uses, so the vendors merge the browser and server event; the CAPI order id is `orders.id` too.
- An organic order (no click id) has pixel / CAPI rows only and no S2S row; reports show it as Organic (US-029).
- Only SHA-256 hashes of the normalised e-mail and phone leave the system (Meta: digits with country code, no `+`; TikTok: E.164). The raw values
  are never sent or logged. `fbp`, `fbc`, `ttclid`, the client IP and the landing page's own address are sent as the vendors require.
  The orders keep a hash of the user agent only, so no `client_user_agent` is sent: see "Unverified".

## Credentials the Owner enters

- **Adnet secrets**: Adnets page, `{secret:name}` in a template. Bound to that adnet and its postback host; removed if the host changes.
- **CAPI access tokens**: Landing pages page, "Server-side conversions": one write-only token per Meta pixel / TikTok pixel (sealed with the
  conversions public key; bound to graph.facebook.com / business-api.tiktok.com; named `capi.meta.<pixel id>`, `capi.tiktok.<pixel code>`). Two
  pages with one pixel share its token. Until a token is set the conversions of that pixel wait, fail visibly on the 1 m / 5 m / 30 m / 2 h / 12 h
  schedule and raise an alert (`capi_token_missing`); set the token and re-fire them.
- worker.env needs `SECRETS_CONVERSIONS_PRIVATE_KEY` (escrow). Without it no conversion is sent, the worker says so at start and, in
  production, raises a critical alert `conversions_disabled` (the worker keeps running: payments and deliveries do not depend on it).

## Delivery rules (exactly once)

- One row per (order, sink, kind) (`conversion_events`, unique key). The worker claims a row with a lease and records the outcome conditioned on its
  attempt number; a 2xx is `sent` and a sent row never leaves `sent` by any code path (the database refuses it, ET083).
- Failures retry after 1 m, 5 m, 30 m, 2 h, 12 h, then the row is `failed`. A request that may have reached the sink (a timeout, an expired
  lease, **a redirect: the sink got the request and chose to send us elsewhere; a redirect is never followed and is not a "no"**) is NOT retried
  blindly for an adnet: it becomes `failed` ("needs manual re-fire"), because the adnet has no event id to dedupe on. Meta and TikTok dedupe by
  `event_id`, so theirs are retried. The fire has a time budget (`WORKER_CONVERSION_TIMEOUT_MS`, shorter than the lease) that is handed to the
  request; a request whose budget ran out while it was being prepared is not sent.
- **"May have counted" is sticky** (`conversion_events.maybe_counted`): set on a 2xx and on every uncertain send, and cleared by nothing, not by
  an Owner re-fire and not by payments. A refund reverses exactly the MTs that carry it (or are in flight), whatever state the row is in by then.
  An MT whose every attempt was answered with an error never counted: no reversal row is made for it.
- **The payout is a snapshot.** The claim of an S2S MT stores the payout it is about to report (`reported_payout_idr`); the reversal's `{payout}`
  is that amount, not the adnet's setting at refund time. Once an attempt may have counted, its snapshot stands for later attempts.
- The MT of an order that is no longer PAID is never sent: checked when it is claimed, and again when the outcome is recorded, under the order's
  share lock. A refund that lands while the request is out and an answer that says "retry" take the row out of the send path (`failed`,
  `order_not_paid`) with its attempt logged. A refund cancels the MT rows that did not leave; a reversal waits for an MT in flight and is skipped
  (`failed`, "skipped: the MT never reached its sink") when the MT never counted. An attributed order whose adnet has no MT template gets its
  S2S row already `failed` ("the adnet has no mt postback template"): fix the adnet and re-fire it.
- The lease sweeper takes the order's share lock with the row (`SKIP LOCKED`, the lock order of the claim), so a review to paid that is still in
  flight is never read half done; a row it cannot lock is simply met by the next sweep.
- **Manual re-fire** (Owner, audited): `refireConversion` (admin `lib/settings/conversions.ts`, the database function `refire_conversion`, owned
  by the NOLOGIN role `conversion_refire`, which is also the only caller the sent-final guard lets through). It re-fires a `failed` row; a `sent` row
  only with an explicit confirmation; a row payments cancelled (`order_not_paid`) once its order is paid NOW (Owner decision: it takes the order's share lock, and the MT of an
  unpaid order is refused by the database, ET080; the claim and the sweeper still never resurrect such a row, payments revives it itself). The console's login has no INSERT, UPDATE or DELETE on the conversion log at all. The Reports page (US-029) carries the
  button and the source column: `public.order_source_label(orders.adnet_id, orders.clickid)` is `Organic` for an order with no click id (or no adnet: AC-T8 defines organic by the
  click id, and the checkout keeps the adnet of an order whose click id was dropped), else the adnet's name. Such an order has no S2S row.

## Logs

Each attempt is a `conversion_attempts` row: the URL with `{secret:name}` masked (never the secret), the HTTP status, the first 4 KB of the answer
with every secret value replaced by `***`, the latency and the attempt number. Alerts and worker logs carry ids and statuses only.

## Unverified until real credentials (US-005)

The vendor payload builders (`packages/adapters/src/conversions.ts`) follow the vendors' documentation but no real account has accepted one yet.
Before the first campaign, in Meta's and TikTok's test-event tools check: the event names above, the `event_id` dedupe against the browser event,
the hashed fields, the Graph API version (`META_GRAPH_API_VERSION`, default `v24.0`), and that **`client_user_agent` is not required**: Meta lists it
as required for `action_source: website`. If it is, the checkout must store a truncated raw user agent on the order (a privacy decision for the
Owner) or the events must use another `action_source`.
