# Help Block Overrides

> **PROJECT:** Trivia Arena | **Component:** the shared "Butuh bantuan?" block (`apps/public/src/components/help/help-card.tsx`) | **Locale:** Bahasa Indonesia
> Overrides `../MASTER.md` for this one component. Owner decision 2026-11-24: a buyer with a problem reaches a person.

## Consistent Help (WCAG 2.2, 3.2.6)
- ONE component, the same look and the same relative place on every buyer page: at the end of the main content column, before any footer. Pages: the order page (every state), the order lookup, `/login`,
  `/masuk`, the trivia home, program and set pages, the slow-down note, and the not-found and error pages. A new buyer page adds the block; it never builds another help area.
- Not in the page's header or the card's footer, and never moved by a state: the same block in pending, paid, expired, failed, review and refunded.
- Renders NOTHING when the Owner has set no CS number and no CS e-mail (no empty card, no dead button). Hours alone are no contact.

## Content
- Heading "Butuh bantuan?" (`h2`, Russo One 18px, Phosphor `Lifebuoy` duotone, `aria-hidden`), one line of context (16px), the hours when set ("Jam layanan: ..."), then the buttons.
- "Chat CS via WhatsApp" (primary, Phosphor `WhatsappLogo` fill) opens `https://wa.me/<digits>?text=...` in a new tab (`rel="noopener noreferrer"`, "(buka di tab baru)" for screen readers); "Email CS"
  (outline, Phosphor `EnvelopeSimple`) opens `mailto:...?subject=...`. Only the buttons the Owner has a contact for.
- The prefilled text and the subject carry the order CODE where the page knows it ("Halo CS, saya butuh bantuan untuk pesanan <kode>."), nothing else; never the buyer's name, e-mail or phone, never the
  order's public id. Without an order: "Halo CS, saya butuh bantuan."

## Layout and sizing
- A card of the column's width (`max-w` of the page's own column: 480px order and not-found, 420px login, the grid's full row on the trivia pages), radius 16px, 1px border, `--shadow-md`, 16px padding
  (24px from 768). Buttons are full width and stacked up to 640px, side by side after; each is at least 48px tall (44px is the floor), the label never wraps at 360px.
- Body text 16px; the hours line `muted-foreground` on `card` (covered by `pnpm check:contrast`). No emoji; Phosphor icons only. Dark mode follows the tokens, no raw hex.

## Pointers from error states
- A message that may need a human ends with "Hubungi CS di bawah." only while the block is shown (an invalid or used login link, a login code that does not work, a failed, expired, in-review or refunded
  order, an order paid but not received, "no program yet" on the trivia home). Never a pointer to a block that is not there.
