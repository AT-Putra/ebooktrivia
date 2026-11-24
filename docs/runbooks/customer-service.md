# Customer service: how a buyer with a problem reaches a person (Owner decision 2026-11-24)

A buyer whose WhatsApp says "not the buyer's number", whose login link expired, whose payment failed, who did not get the ebook or cannot reach the trivia must be able to reach a **human**: the Owner's
customer-service (CS) WhatsApp number or e-mail. This page is how that is set up and where it shows. The code: `packages/core/src/cs-contact.ts` (the formats), `apps/admin/src/lib/settings/cs-contact.ts` (the
page), `apps/public/src/components/help/` and `apps/public/src/lib/cs/` (the buyer site), `apps/worker/src/delivery/messages.ts` (the replies and the template variables). Migration `0027_cs_contact.sql`.

## 1. Set it: Admin, Customer service (Owner only)

Three fields, each may be empty, and an empty one is shown nowhere:

| Field | What | Shown to a buyer as |
|---|---|---|
| WhatsApp number | an Indonesian mobile number, stored as E.164 | `0812-3456-7890` as text, and a "Chat CS via WhatsApp" button (`https://wa.me/<digits>?text=...`) |
| E-mail | an address, stored lower-case | an "Email CS" button (`mailto:` with a subject) |
| Hours | one line, 80 characters at most, shown as written | "Jam layanan: ..." in the help block, and in brackets after the contact in a WhatsApp reply |

Every change is audited (the number and the address as personal-data references, the hours as a value). Staff do not see the page. One row (`cs_contact`, `id = 1`); `public_rw` and `worker_rw` may read
the three fields and nothing else (not who edited it, not when).

**The CS number must never be one of the WhatsApp sending numbers** (`waha_sessions.phone`, active or not): a buyer who writes to a sending number is answered by the pool's robot, not by a person. The page
refuses it with a clear message, and Settings, WhatsApp refuses a session added or edited with the CS number. Both sides are held by the database (`ET190`, two triggers that take one lock), so no writer can
bypass it and two saves at the same moment cannot both pass. To move a number between the two roles, clear it on one side first.

## 2. Where buyers see it

**The help block "Butuh bantuan?"** (`components/help/help-card.tsx`): one component, the same look and the same place, at the **end of the main column**, on the order page (every state), the order lookup
(`order.<DOMAIN>/` without an order), the login (`/login`, `/masuk`), the trivia pages (home, program, set) and the not-found and error pages. A heading, one line of context, the hours when set and the two
buttons (44 px tall, 360 px wide fits, dark mode follows the tokens). **Only the order code**, on the order page, is put in the prefilled WhatsApp text ("Halo CS, saya butuh bantuan untuk pesanan <kode>.") and
in the mail subject; never the buyer's name, e-mail or phone, and never the order's public id. With no number and no address **nothing is rendered**: no empty card, no dead button.

**Error messages point to it** ("Hubungi CS di bawah.") only when the block is there: a failed, expired, paid-but-not-received, in-review or refunded order, an invalid login link, a login code that does not work,
and "no program yet" on the trivia home. The order card has no help area of its own any more (the `links.help` slot is gone): the block is the one help on a page.

**Reading it is cheap and never breaks a page** (`apps/public/src/lib/cs/contact.ts`): the root layout reads it once per request and hands it to the client components; the answer is kept in the process for
**30 seconds** (a change the Owner saves shows within the minute), one read serves all the requests that arrive while it runs, a read that takes more than 1.5 s or fails is logged
(`cs_contact.read_failed`, with the code `read_failed` or `read_timeout`) and the page renders **without the block** (the last good answer keeps being shown if there is one), and a failed read is not tried again
for 5 s.

## 3. What the worker says

Four fixed WhatsApp replies (`replyText`, `messages.ts`) get a CS line **when a number or an address is set**, and are exactly as they were when none is (hours alone are no contact):

| Reply | When | With a CS contact |
|---|---|---|
| mismatch | another number than the buyer's writes about an order | the old text, then "Jika Anda pembeli pesanan ini, hubungi CS kami di {cs} dengan menyebut kode pesanan." |
| generic | a sender nobody could confirm | the old text, then "Butuh bantuan? Hubungi CS kami di {cs}." |
| not_available | the verified buyer's order is refunded, in review or cancelled | "Pesanan ini tidak dapat kami proses lewat chat. Silakan hubungi CS kami di {cs}." |
| needs_help | the verified buyer's delivery failed | "Ebook belum bisa kami kirim lewat WhatsApp. Silakan cek email Anda atau hubungi CS kami di {cs}." |

`{cs}` is "WhatsApp 0812-3456-7890 atau email cs@contoh.id" (only the parts that are set) and " (<hours>)" after it. The number is **plain text**: no wa.me link in a WhatsApp message (the anti-blocking guide in
`docs/runbooks/delivery.md` warns about links). The line holds no order or buyer data, so a stranger learns nothing from it. The worker reads the contact **when it builds the reply** (no restart, no cache);
if that read fails the reply goes out unchanged and the worker logs `cs_contact_read_failed` (a code, never the error text).

**Template variables** `{cs_whatsapp}` (`0812-3456-7890`) and `{cs_email}` can be used in the **ebook delivery** e-mail (subject and body) and the delivery WhatsApp text (Settings, Templates), **not** in the
openers (short and link-free) or the login code text. A value that is not set renders as an empty string, so word the sentence to read well without it ("Kendala? Chat CS kami: {cs_whatsapp}" rather than
"... di nomor {cs_whatsapp} atau email {cs_email}") or set both. The values are inserted unchanged (an address keeps its dots and underscores) after a check of their shape.

## 4. If it does not show

- Nothing on the buyer site: the contact has no number and no address, or the change is under 30 s old, or the database read failed (look for `cs_contact.read_failed` in the public app's log).
- The Owner cannot save the number: it is a sending number (the message says so), or it is not an Indonesian mobile number.
- A reply without the line: no number and no address set, or `cs_contact_read_failed` in the worker's log.
