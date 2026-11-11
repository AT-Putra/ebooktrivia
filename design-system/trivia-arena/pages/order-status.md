# Order Status Page Overrides

> **PROJECT:** Trivia Arena | **Page:** `/order/[orderRef]` hosted payment status / thank-you (AC-S9) | **Locale:** Bahasa Indonesia
> Overrides `../MASTER.md`. Single centered card; not a landing page.

## Layout
- Single column, max width 480px (375: full width minus 16px gutters; 768+: centered card, 32px padding). Page `background`, card `card`, radius 16px, `--shadow-lg`.
- Order: status header (icon + title + one-line explanation) > order summary > primary CTA > secondary button > help line.
- The help/contact link sits in the same card-footer position in all four states.
- The URL carries only the order reference. No tokens, OTPs, magic links or session-bearing links appear on this page or in anything it copies/shares.

## States (icon + title + text; never colour alone)
| State | Header | Behaviour |
|-------|--------|-----------|
| pending | Phosphor `Hourglass` on info tint; "Menunggu pembayaran" / "Selesaikan pembayaran di aplikasi pembayaranmu. Halaman ini diperbarui otomatis." | Polling indicator active. Primary CTA disabled with reason "Tersedia setelah pembayaran berhasil". Optional secondary link "Buka halaman pembayaran" if the gateway supplied one. |
| paid | `CheckCircle` fill on success tint; "Pembayaran berhasil" / "Ebook dan akses trivia sedang dikirim ke WhatsApp dan email kamu." | Polling stops. Primary CTA enabled. One 300ms check pop (none under reduced motion). |
| expired | `ClockCountdown` on warning tint; "Pembayaran kedaluwarsa" | No polling. Primary becomes "Pesan lagi" (back to the product LP). Trivia CTA hidden. |
| failed | `XCircle` on destructive tint; "Pembayaran gagal" with a gateway-neutral reason | No polling. Primary "Coba bayar lagi"; help line stays. |

## Components
- **Primary CTA (paid):** "Masuk ke Trivia" goes to trivia login (WhatsApp number + 6-digit OTP). Full width, 52px, accent gold with `text-on-accent` (overrides Master white text). Only one primary CTA on the page.
- **Secondary button:** "Kirim via WhatsApp" (outline, 48px, Phosphor `WhatsappLogo`, aria-hidden). Opens a wa.me prefilled message containing only order reference and product name. Hidden in expired/failed.
- **Masked PII only:** WhatsApp `+62 812-****-3456`, email `bu***@g***.com`. No full name. Full values are never in the DOM, `title` or alt text.
- **Polling indicator (pending only):** row "Memeriksa pembayaran..." with a 16px spinner and "Dicek terakhir 10 detik lalu". Poll every 3-5 s with backoff to 15 s for at most 15 minutes, then "Belum ada konfirmasi" with a manual "Periksa lagi" button. Under reduced motion the spinner is static text.
- State changes are announced once in a single atomic `role="status"` `aria-live="polite"` region ("Pembayaran berhasil. Kamu bisa masuk ke trivia."), not per poll tick and never as a bare word/number.
- Order summary is a `<dl>` (product, amount "Rp 49.000", order ref, masked contact); amounts use tabular figures. Order ref has a 44px copy button (`aria-label` "Salin kode pesanan", toast "Tersalin" for 3 s).

## Typography
- State title Russo One 24px; body Chakra Petch 16px/1.5.

## Color
- Status surfaces use `*-soft` backgrounds with `*-soft-foreground` text (semantic tokens) (info/success/warning/destructive) with matching foregrounds; all pairs are covered by `pnpm check:contrast`.

## Anti-patterns
- No help controls that move between states. No submit/retry without loading then result feedback. No emoji icons. No raw hex in components.
