# Landing-page pixels: Owner steps

The landing-page SDK (`packages/sdk`, US-019) fires the MO browser pixel with the server's `event_id`. The ad platforms can also read the
buyer's e-mail address and phone number straight from the page's form fields ("automatic advanced matching"). The SDK keeps that off where
the vendor lets a page do so, and empties the form's values before any vendor script loads; one switch has no client-side form at all, so
it is an Owner step in the vendor's account.

## Every time a pixel id is registered on a landing page

1. **TikTok** (each pixel you register for a landing page): in TikTok Events Manager, open the pixel's settings and turn **automatic advanced
   matching off**. There is no switch for it in the page: TikTok's loader (`analytics.tiktok.com/i18n/pixel/events.js`, read on 2026-11-20)
   takes its plugin configuration, `AutoAdvancedMatching` among it, from the pixel's own configuration on TikTok's side, and `ttq.load` only
   accepts partner options. The SDK also empties the form values before the script loads, which covers a page that is scanned, but the account
   setting is the real control. Server-side conversions (the Events API) send hashed phone and e-mail on purpose; that is a separate,
   deliberate path (AC-T6). The menu names change; if the wording differs, look for "advanced matching" in the pixel's settings.
2. **Meta**: the SDK switches it off in the page (`fbq('set', 'autoConfig', false, <pixel id>)` before `init`; the switch is in Meta's
   `fbevents.js`). In Events Manager, check once in the pixel's settings that automatic advanced matching is not forced on.
3. **Google Ads**: the SDK fires a plain `begin_checkout` and never sets user data. Do not turn on enhanced conversions with automatic
   collection for the conversion action used here.

## Server-side access tokens (Meta CAPI, TikTok Events API)

Registering a pixel id is not enough for the server-side events (US-024, `docs/runbooks/conversions.md`): the Owner also enters the pixel's access
token under the page's pixel ids ("Server-side conversions", write-only). Until it is set, that pixel's server events wait and an alert is raised.
Generate the token in Meta Events Manager (Conversions API, "Generate access token") or in TikTok Events Manager (Events API access token) for
**that pixel**. Use each vendor's test-events tool for the first order: the server event must arrive with the same `event_id` as the browser one.

## What the landing page itself must and must not do

The SDK clears and controls only what it owns, so the page's author must keep two rules (also in `packages/sdk/README.md`, "What the page must not do"):

1. **No Meta or TikTok base code of its own on the checkout page.** A pixel library that is already running cannot be switched to "no
   automatic advanced matching" by the SDK: its `autoConfig false` comes too late for a pixel the page has already initialised, and the
   page's own copy may read the form before the SDK empties it. Register the pixel ids in the console instead; the SDK loads the libraries
   after the order exists. Check the page source of every new landing page (and every ZIP upload, US-023) for `fbq(`, `fbevents.js`,
   `ttq.load` and `analytics.tiktok.com`.
2. **No personal-data input outside the checkout form.** The SDK empties the name, phone, e-mail, `type="email"` and `type="tel"` inputs of the
   `data-ebt-checkout` form only. A second e-mail or phone box (a newsletter field, a footer form) stays filled for a vendor script to read.

The page must also ship `method="post"` and a `disabled` submit button on the form (so nothing is submitted natively before the SDK has
bound).

## What to check after a change of pixel ids

- The vendor script is requested only after the checkout response, and the form's inputs are empty when it runs
  (`e2e/tests/sdk.spec.ts`: "loads no vendor script while the checkout is in flight").
- In the vendor's test-events tool, the event arrives once per order with the order's `event_id` and no e-mail or phone parameters.
