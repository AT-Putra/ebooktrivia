// The order page after a successful payment (the Owner's request of 2026-11-25): the buyer is sent to WhatsApp FIRST, so our number answers a
// buyer who wrote to it (the ebook PDF and the trivia login) instead of writing to a stranger with an opener (which puts the numbers at risk). Its three
// texts are the Owner's to word (admin, Message templates, "Page after payment"), one wording for every program, kept in app_settings under
// PAID_PAGE_SETTING_KEY. The pre-filled WhatsApp message (with the order code the robot needs) and the small login link stay fixed.
//   body    the line under "Pembayaran berhasil";
//   button  the label of the big WhatsApp button;
//   note    the line under the button (may be empty: then nothing is shown).
// Each is one line, trimmed, within its length, with no control, format (bidi, zero-width ...) or line-separator character. A stored value that breaks
// a rule (the database does not check it) is replaced by its default when read, so the page never shows a broken text.

export const PAID_PAGE_SETTING_KEY = "order_page.paid_wording";

export interface PaidPageWording {
  readonly body: string;
  readonly button: string;
  readonly note: string;
}

export type PaidPageField = keyof PaidPageWording;
export const PAID_PAGE_FIELDS: readonly PaidPageField[] = ["body", "button", "note"];

export const PAID_PAGE_DEFAULTS: PaidPageWording = {
  body: "Langkah terakhir: chat kami di WhatsApp. Ebook PDF dan akses trivia langsung kami balas di chat itu.",
  button: "Ambil Ebook & Akses Trivia via WhatsApp",
  note: "Pesan sudah terisi kode pesananmu. Tinggal tekan Kirim.",
};

/** Characters (as the buyer sees them: code points) each text may have; `note` may be empty. */
export const PAID_PAGE_LIMITS: Readonly<Record<PaidPageField, { readonly min: number; readonly max: number }>> = {
  body: { min: 10, max: 300 },
  button: { min: 3, max: 60 },
  note: { min: 0, max: 160 },
};

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Whether `value` (already trimmed) is a valid text for `field`. */
export function isPaidPageText(field: PaidPageField, value: string): boolean {
  const { min, max } = PAID_PAGE_LIMITS[field];
  const length = Array.from(value).length;
  return value === value.trim() && length >= min && length <= max && !FORBIDDEN.test(value);
}

/** The wording from its stored value (any JSON): each field that is missing or breaks a rule is its default. */
export function paidPageWordingOf(stored: unknown): PaidPageWording {
  const record = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const pick = (field: PaidPageField): string => {
    const value = record[field];
    return typeof value === "string" && isPaidPageText(field, value) ? value : PAID_PAGE_DEFAULTS[field];
  };
  return { body: pick("body"), button: pick("button"), note: pick("note") };
}
