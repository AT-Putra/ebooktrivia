# Payments runbook (Midtrans)

What the Owner decides, what the system does, and what to do when it alerts. The mechanics are in `apps/worker/src/payments.ts` (header);
the recordings behind the decisions are in [docs/spikes/R12.md](../spikes/R12.md) and [docs/spikes/api-audit.md](../spikes/api-audit.md).

## What counts as PAID (Owner D10)

- A settlement (fraud status accept or absent), or a **card capture with fraud status accept**. The sandbox showed a successful card is
  `capture` at once and `settlement` only the next day; Midtrans calls capture safe to treat as paid.
- The order is PAID at the capture: deliveries, conversions, eligibility. `orders.paid_at` and `payments.settled_at` are stamped then, once.
  The settlement of the next day is the same payment again: nothing changes, no alert (a settlement of ANOTHER attempt is a double charge).
- A capture with `challenge` never pays (the order goes to review), a capture with `deny` does not either. A wrong amount, currency or status
  code on a capture is a critical `payment_settlement_review`, exactly as for a settlement.
- Code: `classifyMidtransStatus` and `confirmSettlement` (`treatCardCaptureAsPaid`, default **true**; `false` is an explicit opt-out nobody sets).

## A payment Midtrans reverses after we counted it (Owner D9)

Midtrans may flip a settlement to `deny` within 1 to 5 minutes for Permata VA, Mandiri Bill and Indomaret (and a captured card can be cancelled
before it settles). Delivery stays instant: the e-mail is already out when this happens.

When a PAID order's attempt that **held the money** turns `deny`, `cancel`, `expire` or `failure`, whether the news comes from a notification or
from the nightly reconciliation. "Held the money" is a fact stamped once, `payments.settled_at` of that attempt (set when a settlement or a
capture+accept was counted, cleared by nothing), NOT the attempt's last status: an intermediate `pending` or unknown answer in between cannot hide
the reversal (the check fails closed). A `cancel` is gated the same way.

1. the order moves to `review` (the D5 semantics: eligibility is suspended until the Owner decides);
2. the buyer's live (unused) magic links are deleted (`public.revoke_player_magic_links`), but only when the player has no eligible program left
   (another paid order that stands keeps the player eligible and the links untouched: the function returns 0). Nothing issues a new link: a restored
   buyer logs in with a WhatsApp OTP, or with the self-service resend on the login page (US-027 adds it), or the Owner re-sends;
3. a persisted **critical** alert `payment_paid_reversed` is raised (payload: order id, attempt, event, how many links were revoked);
4. deliveries and conversions not sent yet are cancelled (marked `order_not_paid`); **nothing already sent is reversed or recalled**; a live
   winner of the program is flagged `no_paid_order` (fulfilment halts).

What it does NOT do: a deny of an attempt that never held money (the buyer retried with another method) leaves a paid order alone. If ANOTHER
attempt still holds money (a double payment) the reversal only raises a warning (`payment_anomaly`) and the order stays paid.

**What the Owner does with the alert:**
- Midtrans settles it again (a later notification or the nightly reconciliation): the order returns to PAID by itself, the cancelled
  deliveries come back, eligibility returns. The links revoked earlier are gone, so the buyer logs in with a WhatsApp OTP, or with the self-service resend
  on the login page (US-027 adds it), or you re-send a link.
- The money is really gone: refund the order in the console (the refund flow, US-024's reversal rules then apply: the adnet reversal postback and so on),
  or leave it in review. The ebook that was sent stays with the buyer; decide whether that matters.

## Payment methods (Owner D11)

- Console: Settings, Midtrans, "Payment methods and fees". Owner only, every save audited (`app_setting.update` for `midtrans.enabled_methods` and
  `midtrans.fees`). One checkbox per method.
- Default: every method is ON except **ShopeePay, BRI VA, CIMB VA and Kredivo**, which the Owner's Midtrans account has not activated (Snap
  accepts their codes but shows nothing for them; see R12). A database that still holds the old seeded default and was never saved by an admin is
  moved to the new default by the migration run (`sql/seed.sql`); an Owner's own choice is never touched.
- The checkout sends Snap `enabled_payments` with **only the enabled methods**. If none is enabled the checkout answers **503** and takes no order, and the worker
  raises a critical `checkout_no_payment_methods` alert (the console refuses to save an empty list, so this means the setting was emptied elsewhere).
- Before you enable a method: activate its channel in the Midtrans dashboard and check it appears on a sandbox Snap page. A code Snap does not offer is
  silently left out; if every enabled code is unavailable the buyer sees "No payment channels available".
- Fees: every row of the table has a fee, ticked or not: type a fee into a switched-off method and it is saved; a fee already saved for a switched-off
  method **stays** (also when you change it, even to 0). An unticked row with nothing typed and no fee saved stays "not configured" (a stored 0 would make
  the report call it free instead of "fee missing"). Reports price an old order by its stored `payment_type`; they read the fees, never the enabled list.
  `qris` (desktop QRIS and desktop GoPay) reads the fee of `other_qris` AND `gopay` and the dearer applies, so the report never understates.

## Cards: 3-D Secure

When `credit_card` can be offered (it is enabled, or the request names no list so Snap offers its own) the Snap request carries
`credit_card: { secure: true }`. The Owner's sandbox account does **not** default to 3-D Secure, whatever the Midtrans docs say: a 3DS-challenge test card
(`4916 9940 6425 2017`) paid with no step at all when the request said nothing, and got the 3DS 2 challenge (password `112233`, status `capture` with
`three_ds_version 2`) with `secure: true` (docs/spikes/R12.md). Confirm production the same way on the first card order.

## Monitoring that has no alert

The public app cannot write alerts (`public_rw` has no INSERT on `alerts`). Put a **log monitor** on its error lines whose reason is `internal`:
`webhook.midtrans.failed` with `"reason":"internal"` (a Midtrans notification the route could not store: it answers 503 and Midtrans retries four times,
but a sustained fault would otherwise go unseen until the nightly reconciliation) and `checkout.failed` with `"reason":"internal"` (a checkout that
failed for a reason that is not Valkey, settings or the Midtrans key). Page on a few per hour.

## Re-query ordering

Two answers of one Midtrans attempt are ordered by the instant their request was SENT, read from the **database clock** (`requeryInstant`), so a worker
whose own clock is wrong cannot make an older answer overwrite a newer one. The stale one is dropped without changing anything.

## Alerts of this runbook

| Alert | Severity | Meaning |
|---|---|---|
| `payment_paid_reversed` | critical | D9: a counted payment was reversed; the order is in review |
| `payment_settlement_review` | critical | a settlement or capture does not match its order (amount, currency, status code, fraud status) |
| `payment_double_settlement` | critical | a second attempt of a paid order settled: possible double charge |
| `payment_review` | warning | a partial refund or chargeback, a challenge: the order is in review |
| `payment_anomaly` | warning | a status that does not fit the order's state; nothing changed |
| `payment_chargeback` | critical | a chargeback, whatever it does to the order |
| `checkout_no_payment_methods` | critical | D11: no payment method is enabled; the checkout answers 503 |
| `payment_requery_failed`, `payment_requery_misconfigured` | critical | the worker cannot re-query Midtrans |
