// The Midtrans Snap `enabled_payments` codes this system knows (AC-S10), in ONE place: the admin
// console offers them (apps/admin lib/settings/midtrans.ts, stored in app_settings
// midtrans.enabled_methods) and the public app sends the enabled ones to Snap (US-020).
// UNVERIFIED until the US-005 sandbox recordings: re-check every code against the real sandbox
// before production (a wrong code is silently not offered, or Snap rejects the transaction).
export const MIDTRANS_METHODS = [
  { code: "other_qris", label: "QRIS" },
  { code: "gopay", label: "GoPay" },
  { code: "shopeepay", label: "ShopeePay" },
  { code: "bca_va", label: "Virtual account BCA" },
  { code: "bni_va", label: "Virtual account BNI" },
  { code: "bri_va", label: "Virtual account BRI" },
  { code: "permata_va", label: "Virtual account Permata" },
  { code: "echannel", label: "Mandiri Bill" },
  { code: "cimb_va", label: "Virtual account CIMB Niaga" },
  { code: "other_va", label: "Virtual account (other banks)" },
  { code: "credit_card", label: "Credit / debit card" },
  { code: "indomaret", label: "Indomaret" },
  { code: "akulaku", label: "Akulaku" },
  { code: "kredivo", label: "Kredivo" },
] as const;
export type MidtransMethod = (typeof MIDTRANS_METHODS)[number]["code"];

const CODES: ReadonlySet<string> = new Set(MIDTRANS_METHODS.map((m) => m.code));

export const isMidtransMethod = (value: unknown): value is MidtransMethod => typeof value === "string" && CODES.has(value);

/** The known codes of a stored midtrans.enabled_methods value, once each, in stored order; anything else is dropped. */
export function enabledMidtransMethods(stored: unknown): MidtransMethod[] {
  if (!Array.isArray(stored)) return [];
  return [...new Set((stored as unknown[]).filter(isMidtransMethod))];
}
