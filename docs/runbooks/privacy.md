# Privacy: deletion requests (UU PDP) and prize fulfilment proofs

Owner-only. Deletion = anonymization (plan §10 item 6): the person's data is removed from every live table, the pseudonymous order
and play rows stay, so revenue, ROI and reconciliation are unchanged. The column-by-column list is
[docs/compliance/pii-inventory.md](../compliance/pii-inventory.md).

## Handling a request

1. **Record it.** Console, Data deletion, Record a request.
   - Identify the person the way they asked: their WhatsApp number (any national form), e-mail, or an order id from their order
     page.
   - Describe the request: how and when it arrived. Write no phone numbers or e-mail addresses in it.
   - An e-mail used with several numbers is refused: ask the requester for their number.
2. **Verify the requester.** Before you erase, confirm that the request comes from the number or address it names, for example
   by replying from the pool number or by e-mail. The review page shows the matched person (masked), every order with the consents
   given at checkout, and their prizes.
3. **Resolve what blocks the erasure**, if anything:
   - **An undelivered prize.** A winner awaiting confirmation, confirmed or flagged whose fulfilment is not done. Either deliver it
     and mark it done, or forfeit it: Prize fulfilment (or the contest results page before the confirmation), Revoke and re-award.
     The prize then goes to the next eligible player of the results snapshot.
   - **An open order.** A pending order (its payment page can still be paid) or one in review: wait until it expires, or decide
     the review.
   - **A send in flight.** A message or an ad-platform event is being sent this very moment: try again a minute later.
4. **Execute.** Type the request's 8-character reference and erase. It is one database transaction, and a second run is a no-op.
   - Stored proof files are removed right after it.
   - The person can no longer log in: their sessions, magic links and login are gone.
   - A later purchase with the same number is a new person.
5. **Or reject** with a reason (for example, the requester could not be verified). The number is dropped from the request.

The audit log records each step with ids and references only (`privacy.deletion_request`, `privacy.deletion_execute`,
`privacy.deletion_reject`). The request's text and a rejection's reason stay on the request; the audit only records that they
were given. Write no names in them.

## Payments that arrive after an erasure

An erased order keeps its money record, so Midtrans can still report on it. Whatever Midtrans sends is cut down for an anonymized
order before it is stored: `payment_raw_erased_guard` on `payments.raw` and `payment_notifications.raw` keeps only the
transaction's own keys, never `customer_details`.

**A refund or chargeback** of an erased, paid order is applied as usual (the order becomes refunded, the reversals go out). No
customer data comes back.

**A late settlement** of an erased order that was never paid (expired or failed when it was erased):
- **Today, until US-033 routes it to review.** The worker fails closed. The PAID effects try to create the buyer's player from the
  emptied phone, `players_phone_present_check` refuses it (SQLSTATE 23514), and the whole transaction rolls back: no payment row,
  no status change, no player, no delivery. The job is retried with a backoff, failing the same way each time, up to
  `PAYMENT_MAX_ATTEMPTS` (36 re-queries over about 30 hours). Then the outbox sweeper raises the generic critical alert
  `outbox_stuck` (topic `payment.notification`). Nothing is sent to anybody. Pinned by
  apps/worker/test/payments-erased.int.test.ts.
  - What to do: check the payment in the Midtrans dashboard and refund it there. The buyer asked to be forgotten, so there is no
    one to deliver to.
- **Planned (US-033).** The payment is recorded and the player and delivery effects are skipped. The order moves to review, and a
  critical `payment_on_erased_order` alert is raised with ids only. The Owner then refunds it.

## Outside PostgreSQL

PostgreSQL is what the erasure clears and what the PII scan test checks. The rest ages out on its own.

**Valkey** holds no personal data for longer than 24 hours, so the erasure removes nothing there.

| What | Content | Lifetime |
|---|---|---|
| BullMQ jobs (`worker` ACL user) | the outbox row id only | `removeOnComplete` / `removeOnFail` age 24 h (apps/worker/src/queues.ts) |
| `rl:checkout:phone:*`, `rl:otp:phone:*`, `rl:otp:cooldown:*`, `rl:otp:verify:*`, `rl:ml-resend:phone:*` | a truncated SHA-256 of the phone | the window of each limit: checkout.phone_window_seconds and otp.phone_window_seconds (at most 86400 s), otp.cooldown_seconds (at most 600 s), the verify and resend caps 24 h |
| `rl:*:ip:*`, `rl:*:ip48:*` | the client's IPv4 address or IPv6 /64 (or /48) | the window of each limit, at most 24 h (checkout.ip_window_seconds, captcha.ip_window_seconds at most 86400 s; others 1-10 min) |
| `rl:webhook:waha:from:*` | a truncated SHA-256 of the sender's chat id | 10 min |
| `rl:play:*:player:*` | a hash of the player id | about a minute |
| `cache:public:*` | the Cap challenge tokens | their TTL (minutes) |

**Backups** age out within their retention window, which the privacy policy states:
- wal-g base backups and WAL: 14 days;
- the restic copies of pg_dump and /srv/data: 7 daily, 4 weekly, 6 monthly.

Anonymization is never applied to a backup. After a restore from a backup older than an erasure, that erasure is undone in the
restored database: its request is pending again, or missing if it was recorded after the backup.
- Erase every such person again before the console is reopened: execute the pending request, or record and execute a new one.
- For this, keep a list of the completed request references and when they were completed outside the database. Take it from
  `privacy.deletion_execute` in the audit log; the requests hold no phone once completed, so the list must name the person in a
  form the Owner can match, for example the order ids.

## Prize fulfilment proofs

- **Where they are.** Stored under `/srv/data/proofs/` (only the admin container mounts it). They are never served by URL: the
  Owner downloads one through the console (a POST, audited, sent as an attachment).
- **Replacing.** A replaced proof is deleted.
- **On erasure.** The erasure deletes the proof of the subject's fulfilments.
- **Leftovers.** The admin upload sweeper (every 15 min) removes any proof file left without a database row.
