# Delivery of the ebook (WhatsApp and e-mail): Owner and operator notes

US-025 (plan M8). A PAID order has two deliveries: **e-mail** (the PDF attached, sent at once) and **WhatsApp** (from a pool of numbers). On WhatsApp the proactive
message is a short **opener** that asks the buyer to reply (Owner decision D7); the PDF and the login link follow the buyer's **reply**. A buyer who never replies
gets the ebook by e-mail only, which is not a failure and raises no alert. Each message is sent exactly once; an uncertain send is never repeated by the system.

> **Deliveries are ON** once `worker.env` holds `SECRETS_MESSAGING_PRIVATE_KEY` (and the payment key and `DOMAIN`, which the signed download URLs and the login link need).
> The login link in every message is US-026's magic link, issued by the database (`issue_magic_link`, 72 hours, one live link per player and channel;
> `apps/worker/src/delivery/magic-links.ts`). **Login codes (OTP) go out through the same number pool**, with the same rules as every other WhatsApp message (human-like
> sending, first-contact check, caps, health, failover up to 3 numbers, never a second number after a send that may have gone out).
> A paid order whose messages have not been sent keeps its `pending` delivery rows; nothing is lost while the runtime is off.

## What to set up

| Where | What |
|---|---|
| Admin, Settings, WAHA | Servers and numbers (sessions): a **weight** (share of the sends) and a **daily cap** per number. The pool only sends from a number whose WAHA status is `WORKING`. A number's **daily budget of new contacts** is `waha_sessions.new_contact_cap` (default 30, a column until the console gets a field for it), held down by the **warm-up** while the number is new (below). Each session panel says where its warm-up is ("Warm-up: day X of 21 - today's new-people limit N", or "Established number"); the box **Established number (skip warm-up)** is ticked for a number that has already been writing to new people for weeks (unticking it on one restarts the warm-up from today, audited). |
| Admin, Settings, SMTP | The mail server; the e-mail goes out of it with the PDF attached. |
| Admin, Settings, OTP and rate limits | **Wait before the proactive WhatsApp opener** (`delivery.wa_delay_seconds`, default 180 s, 0 = at once, at most a day). It applies to orders paid from now on. `WORKER_WA_DELAY_MS` (worker.env, ms) is only the fallback while the setting is missing. |
| Admin, Settings, Templates | `delivery` (WhatsApp, and e-mail: subject and HTML body). The e-mail's plain-text part is made from the same template, so an edit reaches both parts. `delivery_opener_N` (WhatsApp, 3 to 20 of them; **Add wording** creates the next N, **Remove wording** asks twice; ten are seeded): the **opener wordings**: short, text only (no file, no login link: they cannot contain `{link_trivia}`), `{nama}` is the buyer's **first** name, `{sapaan}` a greeting of the time of day in Jakarta (04:00-10:59 Selamat pagi, 11:00-14:59 Selamat siang, 15:00-17:59 Selamat sore, 18:00-03:59 Selamat malam; one message in three a casual Halo or Hai instead), `[[cukup|tinggal]]` one of 2 to 5 options drawn at send time (WhatsApp texts only: an e-mail refuses `[[` and `]]`), and they ask the buyer to reply. The worker picks a wording at random for each buyer and **never repeats one a number used for its last 3 openers** (`delivery_openers.variant_key` says which one an opener used): keep the wordings different. Values are escaped; angle brackets of a buyer's name are dropped from plain-text parts. |
| WAHA box, webhook | URL `https://api.<DOMAIN>/api/v1/webhooks/waha`, events `message`, `message.ack` and `session.status`, HMAC key = `WAHA_WEBHOOK_HMAC_SECRET` of public.env (header `X-Webhook-Hmac` with the lower-case hex of HMAC-SHA512 over the raw body, and `X-Webhook-Hmac-Algorithm: sha512`). **A manual step, see "Setting up the webhook" below: nothing in our code ever changes a session's configuration.** |
| provision.env | `WAHA_ALLOWED_CIDRS`: the addresses Caddy lets POST to that URL (everyone else gets a 404 before the app; the HMAC is checked on top). Use the WAHA server's address **as Caddy sees it**: its public address for a WAHA on another host; for a WAHA that reaches Caddy over the internal container network, that network's CIDR (a WAHA box that posts the webhook to `https://api.<DOMAIN>/...` through the host's public address is seen as the host's address). `0.0.0.0/0 ::/0` removes the allowlist and leaves only the HMAC. |
| worker.env | `SECRETS_MESSAGING_PRIVATE_KEY` (turns deliveries on) and `SECRETS_PAYMENT_PRIVATE_KEY`, plus `DOMAIN`. Optional knobs are listed in `apps/worker/src/delivery/config.ts` (`WORKER_DELIVERY_LEASE_MS`, `WORKER_WAHA_TIMEOUT_MS`, `WORKER_WA_WARNING_FACTORS`, ...). |
| public.env | `WAHA_WEBHOOK_HMAC_SECRET` (without it the webhook answers 503), `SECRETS_PAYMENT_PRIVATE_KEY`. |

### Setting up the webhook (manual, and it must keep what is already there)

The Owner's WAHA instance **also hosts another application's session and webhook**. WAHA's `PUT /api/sessions/{session}` **replaces the whole session configuration**, so a
call that only names our webhook would silently delete the other application's entries. For that reason **no code of ours ever calls `PUT /api/sessions/{session}`** (or any call
that changes a session's configuration): the worker only reads sessions (status, timelock, capping) and sends messages.

Do it by hand, once per session of ours:

1. Read the current configuration (`GET /api/sessions/{session}`, Swagger or the dashboard) and copy `config.webhooks` as it is.
2. Add our entry to that list, **keeping every existing entry unchanged** (URL, events, HMAC, retries, custom headers): URL `https://api.<DOMAIN>/api/v1/webhooks/waha`,
   events `message`, `message.ack`, `session.status`, `hmac.key` = `WAHA_WEBHOOK_HMAC_SECRET` of public.env.
3. Save it from the dashboard (or one `PUT` made by a person with the **complete** list), then read it back and check that the other application's entries are still there.
4. **Verify with a real delivery on staging**: send a message to the number and confirm the webhook is accepted (`message` stored, no 401 in the public app's log). The verifier
   follows the WAHA docs (`X-Webhook-Hmac` = hex HMAC-SHA512 of the raw body, `X-Webhook-Hmac-Algorithm: sha512`), but no signed delivery of this instance has been seen yet.

The ebook download URL (`https://api.<DOMAIN>/files/deliverables/<id>.pdf?exp&sig&n`) is signed by the worker and verified by the public app with a key
derived from the payment private key (both hold it); `n` is a random nonce minted with every URL and covered by the signature (`HMAC(key, "ebooktrivia/files/v2\npath\nexp\nn")`). WAHA fetches
it for the file send (valid 10 minutes). An e-mail whose attachment the server
refuses for its size (or a PDF over `WORKER_EMAIL_ATTACH_MAX_BYTES`, 15 MiB) goes with a 72-hour link of the same kind instead. No link is ever valid for more than
72 hours (the signer refuses a longer one, and the verifier refuses an expiry further out than that). Rotating the payment key voids every outstanding link
(see the rotation note in `staging-provision.md`).

The download is limited **per signed URL**, not per client address: at most 10 downloads of one URL (WAHA retrying a fetch, or a leaked link), counted on the URL's path,
expiry and own nonce, so two URLs of one file (the worker's pre-flight and WAHA's) never share a counter, and the counter lives exactly as long as the URL. WAHA downloads from one address for every delivery of a burst, so a per-address limit would have stopped deliveries. While
Valkey is down a short-lived URL (10 minutes or less: WAHA's) is still served, because its signature authenticates it and it expires on its own; a long one (the
72-hour e-mail link) answers 503 until Valkey is back.

### The file check around every WhatsApp file send (US-005, R11)

**WAHA does not refuse a file URL it cannot fetch.** On the Owner's WEBJS it sends the answer page (a 404's HTML, 21 KB) as the document under the requested file name and answers `201`;
the old assumption of US-025 ("WAHA answers 422 when it cannot fetch the file") is **FALSE for WEBJS**. The buyer would get a broken file and the delivery would look `sent`. So the worker
checks on its side, twice (every WhatsApp file send: the buyer-first PDF and the D6 PDF-only reply):

1. **Pre-flight, before the send.** The worker signs its **own 60-second URL** for the same file and fetches it: it must answer `200`, `application/pdf`, a `Content-Length` equal to the stored
   size, and a body that starts with `%PDF-`. (A separate URL with its own nonce, so the check never uses up WAHA's 10 downloads per signed URL.) The request goes through the worker's
   safe-fetch, with a budget of its own (5 s, `PREFLIGHT_TIMEOUT_MS`, never WAHA's request timeout). **The worker therefore needs public egress to `https://api.<DOMAIN>`** (https only, and no private,
   loopback or metadata address: the same egress rules as every call the worker makes): a worker VM that cannot reach its own public API address, for example behind a private-only DNS name or a
   firewall that blocks its own public IP, gets `file_unavailable` for every WhatsApp file until that is fixed. Otherwise **nothing is sent**: the delivery goes back to pending
   (`file_unavailable`, "not attempted"), the number's health is not touched, the e-mail path is unaffected, and the critical alert `delivery_not_attempted` (key `file_unavailable`) is raised.
   Fix the route (the public app's `/files/deliverables/...`, its proxy, the Valkey counter, the file on the worker's data volume) and the delivery goes out on the next attempt.
2. **Read-back, after the send.** The message is read back (`getMessage`) and its delivered size (`_data.size`, `mediaSize`) is compared with the stored size. A mismatch means WAHA delivered
   a different file: the delivery stays `sent` with `last_error = delivered_wrong_file`, the critical alert `delivery_wrong_file` is raised, and it is **never resent automatically**: the buyer already
   holds the message, so a person decides. The delivery report shows the code and the alert says what to do; the console cannot resend a `sent` row (the database refuses it, ET133), so the Owner
   sends the file to the buyer by hand if needed (the buyer also has the PDF by e-mail). The delivery report lists the row under "Needs attention" for information only (see "The way back" below): the Owner
   reads a note, Staff see the code, and nobody gets a resend button. A size WAHA does not report is only a debug line, not an error.

**Deploy the worker and the public app together, the worker FIRST.** An old worker has no pre-flight, so it would hand WAHA a URL without checking it, and the signed file URLs changed shape
(`files/v2`: an `n` nonce the signature covers): the new public app refuses every `files/v1` URL (no `n`) as malformed, and WEBJS would then send that refusal page as the document. With the new worker
first, a public app that is still old refuses the new URLs, but the pre-flight catches it (`file_unavailable`, nothing is sent, an alert) until the public app follows. No `v1` link was ever issued outside
development, so nothing already sent to a buyer stops working.

## Owner checklist for every WhatsApp number (from WAHA's "How to avoid blocking")

WhatsApp restricts numbers that look like spam. Before a number joins the pool:

1. **A profile picture, a name and a status** on the number. Messaging someone new without them raises the chance of being reported as spam (five to ten reports lead to a ban).
2. **Warm it up**: use the number for a while with real conversations, start with a **low volume** and raise it over weeks, not
   all at once. The pool does this for a number marked new (the **warm-up**: new contacts a day by WIB day since `waha_sessions.warmup_started_at`: days 0-6 five, 7-13 ten, 14-20 twenty, day 21 on the number's own `new_contact_cap`; replies and chats the number already has are never held down). Sessions that existed when the warm-up shipped started their warm-up then; new sessions start it when created unless **Established number** is ticked. A brand-new number that writes to many new contacts on day one is the classic way to get restricted.
3. **Group numbers by area code** where you can (regular users mostly message people near them): give each area its own numbers and weights.
4. **Keep the content non-spammy**: the opener is one short real message, never several; the wording varies (ten wordings, a number never repeats one of its last three, and `{sapaan}` / `[[a|b]]` vary the text itself); links are HTTPS and not shortened
   by a service WhatsApp has flagged. Anything that makes buyers report you costs the number.
5. Never restart, log out or re-pair a restricted number: it does not lift the restriction (see below).
6. **Write one message ("hello") from the Owner's alert phone to the new number**, so the Owner's alerts can come from it ([alerts.md](alerts.md): the pool picks any number for an alert, and
   WhatsApp may refuse a first message to someone who never wrote to that number). Tick it in the go-live checklist (GL-16) for every number.

## Human-like sending (every WhatsApp message: openers, replies, login codes)

A message is never just posted. The worker follows WAHA's recommended order, with every pause drawn **per message and per recipient** from the operating system's
random source (`crypto.getRandomValues`; a log-normal distribution, so most pauses are short and a few long, clamped to bounds; never a fixed timing and never the same delay
twice in a row). The pacing is drawn from that source too: the random gap between the sends of a number (3 to 9 s) and the contact gap (30 to 60 s), never `Math.random`:

1. **Seen**: the **whole chat** is marked as read before anything is sent, for every kind of message (opener, reply, text, file, test-send, OTP): `POST /api/sendSeen` with **no
   message ids** (falling back to `POST /api/{session}/chats/{chatId}/messages/read`). Older unread messages of that person must not stay unread while we write to them: a number
   that sends while the earlier messages sit unseen looks like a bot (Owner rule, 2026-11-24; WAHA "How to avoid blocking");
2. a **reading** pause: 0.6 to 4 s (every kind except an OTP, which has none);
3. **typing** starts (`POST /api/{session}/presence {chatId, presence: "typing"}`);
4. a wait **scaled to the length of the message**: a base of 1.2 to 2.5 s plus 35 to 75 ms per character (the rate is itself random per message), clamped to 2 to 14 s;
5. **typing stops** (`presence: "paused"`), then a short pause of 0.3 to 1.5 s;
6. the message is **sent**;
7. the session goes **offline** again (`presence: "offline"`): while a session shows online the phone gets no notifications.

A login code (OTP) stays quick: it marks the chat as read too, but with no reading pause (one quick best-effort call), then typing at most 3 s and a pause of at most 0.9 s, under 4 s of pauses in all.

**Incoming messages are marked as read too.** Every personal message the worker processes (`waha.inbound`, after the re-fetch confirmed it: not ours, a phone or `@lid` chat, never a
group, a status or a channel) has its whole chat marked as read on the number it arrived on, after a random reading pause (0.6 to 4 s), **before** the worker decides what to do with it, whether
it gets a reply or not (no order code, an unknown code, a stranger, a rate-limited sender, a buyer). A reply's own send marks the chat once more (one extra cheap call, accepted instead
of a flag to skip it). Like the others it is best effort: a failure is only logged as a code and never fails or retries the job or holds back the reply. The job's lease allows for it
(`READ_MARK_MAX_MS` in `inbound.ts`: the longest pause plus the two calls' timeouts).

Per contact (a phone, whichever number writes): a **second message waits a random 30 to 60 s** after the previous one, and **at most 4 messages an hour**. A code that
would have to wait longer than 10 s for that gap is not sent late: the outbox retries it (the code lives 5 minutes).

Seen, typing, paused and offline are **best effort**: each has a 3 s budget, a failure is only logged as a code, and it never fails, retries or counts against the send,
and never makes it "maybe sent". No database lock or transaction is held during any of it. If the job is aborted, or its lease can no longer cover the send, during a wait,
**nothing is sent** (the delivery goes back to pending: "not attempted"). The lease (`WORKER_DELIVERY_LEASE_MS`, default 210 s) covers the worst case: the number's slot (20 s),
the contact gap (60 s), the first-contact lookup (10 s, an opener), the file pre-flight (5 s, a file), the pauses and presence calls (34.5 s), the send (`WORKER_WAHA_TIMEOUT_MS`, 60 s), the read-back
of a sent file (3 s) and a margin (10 s); the worker refuses to start with a lease shorter than 202.5 s (at the default request timeout). A claim too old for the pre-flight, the sequence, the send and the
read-back together is not sent, and the read-back alone is skipped when what is left of the lease cannot cover it. The bounds are constants in `packages/core/src/human-send.ts`; the request bodies and answers are **recorded** on the Owner's WAHA (2026.10.1, WEBJS; `docs/spikes/R11.md`):
presence and `sendSeen` with ids answer `201` with **no body** (the adapter accepts that for these calls only), typing answers `{"result": true}`, and reading everybody's presence (`GET`) is not implemented by WEBJS.

**Text is never empty.** WEBJS does not refuse an empty `text`: it sends an empty message. The adapter refuses an empty or whitespace-only text before calling WAHA (`NotSentError`, a `RangeError` subclass raised only by the checks before any request: nothing is sent).

## How a delivery goes

1. **Claim.** One conditional database update takes a pending delivery (`pending` to `sending`, with a lease). Only one job wins, whatever races. An order that is
   not paid is never claimed (the row is taken out with payments' own mark and only payments brings it back).
2. **Pick a number** (WhatsApp). Weighted round-robin over the `WORKING` numbers: not one this opener already tried, under its daily cap (WIB day), not
   resting, with a send slot at most 20 s away. Every number paces itself with a random 3 to 9 s gap between sends, so a burst is spread out and never blasted.
3. **First contact.** Before the first message to a phone, WAHA is asked `GET /api/contacts/check-exists?phone=<digits>&session=<name>` (`{numberExists, chatId[, pn]}`: recorded, a `@lid` contact comes back with **no `pn`**) and the
   message goes to the **chat id it returns**, which since WhatsApp's LID rollout can be `<lid>@lid`: we never build `<phone>@c.us` for a first contact (a message to a chat id
   that is not the contact's is silently dropped). The answer is cached per phone in `wa_contacts` (a month when the phone is on WhatsApp, a day when it is not) and reused
   for later sends and for matching an inbound `@lid` sender. If the phone is **not on WhatsApp** the opener ends in a final `no_whatsapp`: no failover, no penalty for any
   number, no alert; the e-mail still delivers and the order page's WhatsApp button stays. A lookup that fails (5xx, timeout) sends nothing and waits for a backoff: it is
   never "maybe sent".
4. **The opener** (Owner decision D7). One of the Owner's wordings, picked at random when the opener is claimed (never one this number used for its last 3 openers; recorded as `delivery_openers.variant_key`), with the buyer's first name, `{sapaan}` and `[[a|b]]` filled in when it is sent, text only (no PDF, no link), through the human-like sequence.
   It is exactly-once on its own (`delivery_openers`: `pending` to `sending` to `sent`; the database refuses any way back, ET131): a definite failure fails over to another
   number at once (up to 3; a pool with ONE number tries it again after a minute), an uncertain one is `unknown` and **never resent**, one nobody can send (every number tried)
   fails **quietly**, and one still unsent 6 hours after its time is dropped. The **delivery row stays `pending`** meanwhile. **Not attempted**: a failure BEFORE anything was
   sent that is ours (a template did not render, the lease can no longer cover the send) is not an attempt: the opener goes back to pending after a short backoff, the
   number leaves the tried list and its health is not touched (only WAHA's own answers count against a number); it raises the `delivery_not_attempted` alert.
5. **The reply.** When the buyer answers (or uses the order page's "Kirim via WhatsApp" button) the buyer-first path claims the SAME delivery row (`pending` to `sending`)
   and sends the PDF with the login link from the number the buyer wrote to, in that chat, through the human-like sequence (the chat is marked as read first). An opener not yet sent is then
   moot (dropped). A definite failure of this send puts the row back to `pending` (the buyer can write again, to another number: the row remembers the numbers it tried), and after
   **three numbers** have failed it is `failed` (with an alert, and in the "Needs attention" list for a resend); an uncertain one is `unknown` and **never resent**.
   E-mail retries after 1 min, 5 min and 30 min (4 attempts), then the delivery is `failed` with an alert, except that an **SMTP 5xx answer (the server refuses the message)
   fails the delivery at once**: a retry cannot help.
6. **Unknown.** A timeout, a reset or a 5xx may mean the message went out. The delivery becomes `unknown` and is **never resent**. After its lease ends the
   worker looks at what the number really sent to that chat (a message with the file name inside the lease window): a match settles it as `sent`. Anything else waits
   for you, with an alert after 30 minutes. A real resend is a manual action (US-029); the database refuses every automatic way back (ET130).

## WhatsApp's own limits: reachout timelock and message capping

WhatsApp **shadow-restricts** a number that writes to too many NEW contacts, and this is the likely cause of first messages that silently do not arrive. Two states exist
(WAHA docs, Sessions): the **reachout timelock** ("server returned error **463**") and **message capping**, a per-cycle quota of new contacts ("server returned error **475**"; its
state is `NONE`, `FIRST_WARNING`, `SECOND_WARNING`, `CAPPED`). In both the session **stays `WORKING`**, WAHA does **not** block the API call, WhatsApp may not push the state, and
**restarting, logging out or re-pairing does not reset either**: they end by themselves, at the time WhatsApp gives (`timeEnforcementEnds`, `cycleEnd`). A restricted number **can still reply in
existing chats** (a buyer who wrote first, the PDF after a reply); only NEW contacts are blocked. The worker therefore:

- polls `GET /api/sessions/{session}/timelock` and `/capping` for every `WORKING` number every **3 minutes**, and again **right after any 463 or 475**; it also takes them from a verified
  `session.status` webhook (`data.reachoutTimelock`, `data.messageCapping`). Both states are saved on the number (`waha_sessions`: timelock, capping, quotas, cycle end, when it was checked,
  and how many times WhatsApp answered 463 and 475). **The poll is the authority**: when WAHA answers both calls and says the number is not limited, the block is lifted (not right
  after a refusal of WhatsApp itself: the hold of the refusal stands until the next poll). The webhook may only **extend** a block, and by **24 hours at most per event**;
- **excludes a timelocked or `CAPPED` number from new-contact sends** (openers, login codes) until WAHA's end (an hour when WAHA names none), while it keeps answering existing chats;
- on a 463 or 475 treats it as a **number-level cooldown, not a failure**: the number's health is not touched, the opener goes back to pending for another number, and a persisted
  critical alert `waha_reachout_blocked` (with the 463 and 475 counts) is raised; it never restarts or re-pairs anything;
- on `FIRST_WARNING` / `SECOND_WARNING` **slows that number down**: its daily budget of new contacts (`new_contact_cap`) shrinks to 50 % / 25 % (`WORKER_WA_WARNING_FACTORS`, default `0.5,0.25`)
  and its gap between sends doubles / quadruples, and an alert `waha_limits` (warning) is raised;
- if **every number is excluded**, new-contact openers **wait** (they stay `pending` and are tried again every minute) rather than fail, with the alert `wa_reachout_blocked`; the e-mail covers
  the buyers meanwhile.

A "new contact" is judged **per number**: a chat the number already has with that phone (it sent to it, or the phone wrote to it, in the last 30 days) is not a new contact for it.
Each number has a **daily budget of new contacts** (`new_contact_cap`), separate from its replies, so openers can never use up the capacity for replies (`wa_new_contact_budget_spent`
when every number has spent today's). The shapes of the timelock, capping and `@lid` answers are **verified live** (US-005 audit, WAHA 2026.10.1, WEBJS and CORE): an account with nothing to report answers `timelock` 200 `{isActive: false, ...}`
and `capping` 200 `{cappingStatus: "NONE", totalQuota: -1, mvStatus: "NOT_ELIGIBLE", ...}`, and an unknown `@lid` answers 200 `{lid, pn: null}` (not a 404). The check-exists answer is **recorded** too (`R11.md`): a `@lid` chat id and no `pn`. A warning or CAPPED state, and 463 / 475, were not provoked: their shape is the documented one.

## Buyer-first ("Kirim via WhatsApp" on the order page, and the reply to the opener)

The buyer messages a pool number with the order code (the button prefills it), or simply replies to the opener (no code needed: the number that wrote is the buyer's, and it wrote to the number
that sent the opener). The webhook (HMAC verified before parsing, bounded, deduplicated by message id, rate-limited per sender) stores a hint (a code-less message is kept only when the chat owes us
a reply), and the worker **re-fetches the message from WAHA** and decides from that:

- the sender is the order's phone: the same WhatsApp delivery row is claimed and the PDF with a login link goes back from that number and chat; an opener not yet sent is dropped;
- the sender is an `@lid` that WAHA cannot put a number to (**Owner decision D6**): it cannot be told from a stranger, so it gets the PDF as an **extra** reply, with
  **no buyer name and no login link** (a fixed caption), and the delivery row is **not claimed**: the opener still goes out on schedule. (An order that is not paid gets the one neutral text instead.)
  The buyer can therefore receive the PDF twice; that is intended;
- the sender is another phone (a stranger who knows a code): one fixed neutral text, the buyer's own delivery is not cancelled;
- the sender IS the buyer but the delivery is not pending: a text that follows the row: on its way (in flight, sent, unknown), "could not send, check your e-mail or
  contact us" (failed), "not available here" (cancelled, or the order refunded, in review), "payment not received yet" (the order is not paid yet). The state of an order is told
  **only to its verified buyer**: an unconfirmed sender never learns whether an order is paid, sent or failed.

Extra replies (the texts, and the PDF for an unconfirmed `@lid`) are limited: at most one per sender per hour (claimed in the database under a lock on the sender before
anything is sent, so two messages at once cannot both pass), and only while the number is under **80 % of its daily cap**, so they can never take the openers' share. No order code and no
opener to answer, or a code of no order: no reply at all.

**A `@lid` sender** is matched to a phone through `wa_contacts` (the lid a check-exists answer taught us), then WAHA's lid lookup, then **from the phone side**. WAHA's lid store is local to a
session (measured on the Owner's WAHA 2026.10.1: a lid never looked up on that session has `pn: null`), while check-exists is a WhatsApp server query that answers for any phone. So when the first two
give no number, the worker asks check-exists, on the receiving session, about up to **5** of our buyers' phones (the **paid** orders whose codes the message carries, the phone of a stale link when a paid order has it, the openers
this number sent in the last 7 days whose delivery still awaits the reply, newest first) and the phone whose lid equals the sender's is the sender. The cache answers first, a negative answer too, so a phone is
asked about at most once a day. Limits, all in Valkey under the worker's key prefix: **one** such round per sender lid an hour (`<prefix>:lid-round:<HMAC of the lid>`, one-hour TTL; the retry of the same message may take it again;
the key holds an HMAC under a key derived from the worker's file-URL key, never the lid) and **30** questions per number an hour (`<prefix>:lid-checks:<session id>`); when either is spent the sender stays unresolved. The whole round has 15 s. A candidate
that fails does not stop the others; if none matches and one failed (or the time ran out), the job is retried, and a Valkey failure retries it too: it is never answered as unresolved. Nothing is sent or stored for a stranger. If WhatsApp gives the **order's own phone** another lid than the
sender's, the sender is a stranger (`text_mismatch`: the neutral text, no PDF, no link, nothing claimed); the PDF-only reply stays for an order whose phone has no known lid. A link we already held is not renewed by a message from its sender. A lid belongs to **one** phone (the column is unique; writing a
lid takes it from the phone that held it), a link older than a **day** is not trusted on its own (WAHA is asked again before a login link can go to that sender), and a phone WAHA names for a lid
is stored only once a message from it matched an order or an opener: a stranger's phone is never kept. If the buyer's reply (the PDF) went to a `@lid` chat, the delivery remembers that chat
(`reply_chat_id`) and the unknown-send lookup asks there as well as in the order's own chat.

## The way back from `sent` / `unknown` / `failed`, and the failed-deliveries list

The database refuses it for every login (ET130): a `sent` row never changes status, an `unknown` or `failed` row may only become `sent` (never `pending`,
`sending` or `cancelled`); the same for an opener (ET131), which has no resend at all. The one door for a delivery is `public.resend_delivery(id, confirm_unknown)`: a SECURITY DEFINER function
owned by the NOLOGIN role `delivery_resend` (no members, `roles.sql`; it may change only the machine's columns of a delivery). The console's login has no write on `deliveries` at all.

**Reports, Delivery report, "Needs attention"** lists the failed and unknown deliveries of paid orders (newest first, buyers masked) with a **Resend** button (AC-A1: Staff may manage resends), and, for information only,
the `sent` deliveries whose WhatsApp file arrived wrong (`delivered_wrong_file`, see "The file check"): counted as "wrong-file", with the Owner-facing note "WhatsApp delivered a wrong file. Check that the buyer received the PDF by email, and send the file manually if needed." Staff see the error code only, and there is
**no resend button** for it (`sent` stays final). The Owner has a **Mark handled** button (permission `delivery.wrong_file_handled`, audited as `delivery.wrong_file_handled`) that takes the row off the list:
nothing about the delivery changes, the report just leaves out a delivery that has that audit entry:

| Delivery | Who may resend | What it does |
|---|---|---|
| `failed` (nothing reached the buyer for sure) | Staff and Owner | Back to `pending`, due now, tries cleared. An e-mail goes out within a minute. A WhatsApp ebook goes out when the buyer writes to one of the numbers (or taps the button on the order page): the opener is never sent again. |
| `unknown` (a send that **may** have gone out: a timeout, a reset, a lost answer) | **Owner only**, and only after ticking "The buyer may already have it" | The same, but the buyer may then get the ebook (and a new login link) twice. The database refuses it without the confirmation (ET132) whoever asks; Staff do not even see the button. |
| `sent`, `pending`, `sending`, `cancelled`, or an order that is not paid | nobody | Refused (ET133 / ET080). |

A resend is refused while the delivery's **lease has not ended** (ET134: a send may still be running; an `unknown` delivery keeps its lease until the lookup has had its chance). `attempts`
**only ever increases** (a resend moves `attempts_base` up to it, which is what gives the retry budget back): an old claim that finishes late can never record its outcome onto a newer one.
Every resend is audited (`delivery.resend`: who, the status it had, the channel, the attempts and the error **as a code**, and whether the confirmation was given). The report shows an error only as a
code (`waha_rejected`, `smtp_rejected`, ...); anything stored that is not a lower-case code is shown as `other`, so an address or a phone number can never reach the page.

**Per number** the report counts the send ledger (`waha_sends`, kept 31 days) of the range: every message a number sent (openers, ebooks, replies, login codes) with how it ended (`outcome`: sent, failed for sure,
unknown, or still in flight). Volume = sent + failed + unknown; failure rate = failed / volume. A phone that is not on WhatsApp, WhatsApp's own limit on new contacts and a fault of ours are in no figure.

## Alerts (persisted in `alerts`, visible in the console)

| Kind | Meaning |
|---|---|
| `wa_pool_empty` (critical) | No number is `WORKING` (or none is configured): WhatsApp deliveries wait, e-mail is unaffected. |
| `wa_pool_exhausted` (warning) | Every number is at its daily cap or resting: add numbers or raise caps. |
| `wa_new_contact_budget_spent` (warning) | Every number has spent today's budget of new contacts: openers wait until tomorrow (or raise `new_contact_cap`). |
| `wa_reachout_blocked` (critical) | Every number is held back from new contacts by WhatsApp (463 / 475): openers and login codes wait; e-mail is unaffected. Do not restart or re-pair. |
| `waha_reachout_blocked` (critical) | WhatsApp refused a new contact from this number (463 / 475, with the counts) and it is held back until the end WAHA gives. Do not restart, log out or re-pair it. |
| `waha_limits` (critical / warning) | WAHA reports a timelock or capping on this number (critical while it is held back), or a FIRST / SECOND warning (its openers are slowed). |
| `waha_session_down` (warning) | One number is not `WORKING` (stopped, QR code needed, WAHA unreachable). |
| `waha_session_failing` (critical) | A number failed three sends in a row and rests for 10 minutes. |
| `delivery_failed` (critical) | A delivery failed on every attempt (or has no PDF): see the failed deliveries. |
| `delivery_unknown` (warning) | A send may or may not have gone out and no lookup could settle it. |
| `waha_lookup_failing` (warning) | A number could not look up whether a phone is on WhatsApp (WAHA failed); one alert an hour per number. Its openers wait and are tried again. |
| `delivery_not_attempted` (critical) | Deliveries are held back by a fault on our side (a template, the ebook file, a lookup that keeps failing, `file_unavailable`: the signed file URL did not answer the stored PDF); the key says which. Nothing was sent; it goes out once fixed. |
| `delivery_wrong_file` (critical) | WAHA delivered a file whose size is not the stored PDF's (the delivery is `sent`, `last_error = delivered_wrong_file`). Not resent automatically: check the file route, then decide a resend with the buyer. |

No alert is raised for an opener that was not answered, one nobody could send, a phone that is not on WhatsApp (`no_whatsapp`), or an opener that may have gone out: the buyer has the e-mail.

## Recorded for later stories

- US-029 (the delivery report, done with US-025): a WAHA ack that arrives before the worker has stored the message id finds no row and is dropped, so `wa_ack` can stay empty for a message
  that was delivered: read the status, not a missing ack. The report shows the opener's state next to each WhatsApp delivery.
- US-030 (retention): keep `waha_inbound.message_id` rows for at least the 60-minute webhook replay window (they are the deduplication); `wa_contacts` holds phones and chat ids (personal data):
  delete a row with its player's anonymization.
- US-030 (retention and deletion): the job must cover `wa_contacts` (phones and chat ids of strangers who were asked about too) and `waha_sends.contact_key` (an UNSALTED SHA-256 of the
  chat id: pseudonymous, not anonymous, so a deletion request for a phone must delete its rows); and the console's `admin_rw` SELECT on `wa_contacts` (personal data) must be reviewed
  (the report does not read it).
- US-005 (real WAHA, DONE, `docs/spikes/R11.md`): recorded on the Owner's instance: the bodies and answers of `sendSeen`, typing and presence, `check-exists` (`@lid`, no `pn`), `timelock`, `capping`,
  the unknown `@lid` (200 `pn: null`), message-by-id through a `@lid` chat, and that the messages lookup filter is `filter.fromMe=true` (a bare `fromMe` is silently ignored, so the lookup sends the right one,
  keeps its own check, and pages back until the time of the send is covered). **Still docs-only: a signed webhook delivery (the HMAC headers, the `message`, `message.ack` and `session.status`
  envelopes, a `@c.us` sender), the exact error text of 463 and 475, and a stopped session's answer to a send.** Verify the webhook with a real delivery on staging (US-014 / US-032).
- US-027 (the player's play surface; US-029 only for the Owner's manual resend): a **self-service magic-link resend** is the recovery path for a player locked out of the OTP (US-026 security review). It is not built:
  the buyer's order page or login page would ask for a fresh link by phone, answered identically for every phone (no enumeration), rate limited, and sent through the pool (`delivery/pool-sender.ts`) with
  `issue_magic_link` (which already supersedes the previous unconsumed link of that channel). The Owner is deciding which story owns it.

Logs and alerts carry ids and codes only: never a phone number, an e-mail address, a message, a login link or a signed URL.
