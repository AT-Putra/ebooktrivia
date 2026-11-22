# Review queue runbook (US-033)

What the Owner decides about orders in `review`, what the system does, and what to do afterwards. The payment mechanics are in
[payments.md](payments.md); the code is `packages/db/sql/order-review.sql` (the decision), `packages/db/sql/functions.sql` (the shared
PAID effects, US-033 block), `apps/worker/src/payments.ts` and `reconciliation.ts` (honouring a decision), `apps/admin/src/lib/review/review.ts`.

## Why an order is in review

The payment code never takes an order out of `review` on its own, except when Midtrans confirms a settlement (PAID) or a full refund or
chargeback (REFUNDED). Everything else waits for you:

- **D9**: Midtrans reversed a payment we had counted (deny, cancel, expire or failure of the attempt that held the money). The buyer's
  eligibility is suspended and their login links were revoked; the e-mail with the ebook already went out.
- **D5**: a partial refund or a partial chargeback of a paid order. Eligibility is suspended.
- A fraud challenge, or a settlement that does not match the order (amount, currency, status code): the order was never paid.
- A full refund or chargeback of an order we never confirmed paid.

## The queue

Console, **Review queue** (Owner only; Staff get 403 on the page and on every action). The navigation badge and the Overview page show how
many orders wait. Each order shows why it is there (the status change and its open alerts, the nightly reconciliation's findings), every
Midtrans attempt with the last re-queried status and the payments ledger, the status history, the amount, the buyer masked and the player's
eligibility. "Show buyer details" shows the full name, WhatsApp number and e-mail; every view is written to the audit log (`order.buyer.view`).

**Re-query Midtrans now** asks the worker (which holds the Midtrans key) to re-query every attempt and apply the answers through the normal
payment path, exactly as a notification. Reload the page after a minute. If Midtrans now says something new (it settled after all, or it
refunded), the order may leave the queue by itself. You can still decide either way afterwards.

## The two decisions

Both need the order's id typed to confirm and a reason (10 to 500 characters, no e-mail addresses or phone numbers: it is kept in the audit
log and the decision ledger). Both run in one database transaction under the order's row lock; a notification or the nightly reconciliation of
the same order waits for it, and whichever comes second sees what the first did (a decision on an order that left review meanwhile is refused).
A double click or a re-posted form is the same request: the same answer, nothing done twice.

**Mark paid** (the money is ours): the order becomes PAID (`paid_at` keeps the first payment's instant if there was one), the buyer is
eligible again and `first_paid_at` is recomputed from the orders still paid. The deliveries and conversions the payment code held back when
the order entered review go out again (only those it held back: never one cancelled for another reason), and an order that was never paid
gets its deliveries, its conversions and the `order.paid` job, exactly as a payment would (one SQL implementation). Login links D9 deleted are
not re-created: the buyer logs in with a WhatsApp code or the login page's "send my login link again". A winner of this buyer that was flagged
stays flagged: reinstate them on the contest results page.

**Not paid** (the money is not ours): the order closes as `gateway_failed` (the buyer's order page says failed; no new payment attempt is
added to it). Eligibility is recomputed from the orders still paid; conversions that may have counted at an adnet get their reversal
postback (as a refund); the buyer's live login links are revoked only if no eligible program is left. Nothing of this order can go out
afterwards (the database refuses any delivery or conversion of an unpaid order).

**An order whose buyer was erased** (a UU PDP deletion, [privacy.md](privacy.md)) reaches the queue when Midtrans settles it later: the
payment code records the payment, makes nothing of it and raises a critical `payment_on_erased_order`. The queue shows "Erased on
request" instead of the buyer, and the paid button is **Keep the money, no fulfilment**: the order becomes PAID and nothing is
delivered, reported or made eligible (the ledger says fulfilment skipped). "Not paid" works as for any order.

Either decision resolves the order's review alerts (`payment_review`, `payment_paid_reversed`, `payment_settlement_review`,
`reconciliation_mismatch`, `order_review_stuck`, `order_decision_superseded`, `payment_on_erased_order`). A chargeback alert and a flagged-winner alert stay: they are
about the money and the prize, not the queue.

## After the decision

The decision is recorded with what Midtrans said about every attempt at that moment (the decision ledger, `order_owner_decisions`).

- **The same Midtrans state again** (a repeated notification, the nightly reconciliation, your re-query): nothing changes and nothing alerts.
  A "mark paid" deny stays paid; a "not paid" mismatch does not reopen review.
- **A new Midtrans event** is processed as usual, and you get a critical `order_decision_superseded` alert (also when the event changes
  nothing about the order, e.g. Midtrans settles a payment you had already marked paid):
  - a refund or chargeback after "mark paid" reverses the order (REFUNDED, reversal postbacks, eligibility recomputed);
  - a real settlement after "not paid" makes the order PAID (late settlement, plan §10 item 8): the money did arrive, so the buyer gets the
    ebook and eligibility. If you had already refunded the buyer outside Midtrans, refund this payment in Midtrans too;
  - another flip after "mark paid" (settled again, then denied again) is a new event: the order goes back to review;
  - "mark paid" makes the attempt that showed the money when you decided (for example a card capture held for a fraud challenge, which
    Midtrans never settled) the payment we count: if Midtrans later denies, cancels or expires it, the order goes back to review exactly
    as a reversed payment does (D9: eligibility suspended, login links revoked, a critical `payment_paid_reversed`). An attempt that showed
    no money then (abandoned, never re-queried) is not: its later expiry leaves the order paid.

**Known limit (staging follow-up).** The fingerprint is the attempt's status and fraud status. Midtrans' Get Status adds a `refund_amount`
and a `refunds[]` list for refunds (docs only: R12 could not record a refund in the sandbox), which the worker does not read yet. So a
SECOND partial refund or partial chargeback of the same attempt after "mark paid" shows the same `partial_refund` / `partial_chargeback`
status and is covered by your decision: no alert. After marking a partially refunded order paid, check the Midtrans dashboard for further
refunds; a full refund or chargeback is a new status and is processed as usual. Fix once a real refund is recorded on staging: parse
`refund_amount` into the status and the fingerprint.

**Re-query Midtrans now** does nothing once the order has left the queue, and nothing within a minute of the last re-query of the same
order (a second press is not a second round of Midtrans calls).

## Alerts

| Alert | Severity | Meaning |
|---|---|---|
| `order_review_stuck` | warning | an order has been in review for more than 24 hours; raised once per stay in review |
| `order_decision_superseded` | critical | a new Midtrans event changed an order you had decided on |
| `payment_on_erased_order` | critical | Midtrans settled an order whose buyer was erased: it is in the queue, nothing was delivered |
