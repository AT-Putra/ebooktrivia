// The Midtrans Snap `enabled_payments` codes this system knows (AC-S10), in ONE place: the admin
// console offers them (apps/admin lib/settings/midtrans.ts, stored in app_settings
// midtrans.enabled_methods) and the public app sends the enabled ones to Snap (US-020).
// Checked against the Midtrans sandbox in US-005 (docs/spikes/R12.md, 2026-11-21): Snap OFFERED other_qris, gopay, bca_va,
// bni_va, permata_va, echannel, other_va, credit_card, indomaret and akulaku. shopeepay, bri_va, cimb_va and kredivo were
// accepted by the API (201) but not offered (the page said "No payment channels available": the same answer as for an
// invented code, so a wrong code and an inactive channel look alike). Snap never rejects a code. Before production, activate
// the channels in the Midtrans dashboard and re-check on the Snap page (a code that is not offered is silently left out).
// Owner D11: each method is a per-method switch in the console (app_settings midtrans.enabled_methods); the default is ON for
// every code here except shopeepay, bri_va, cimb_va and kredivo (sql/seed.sql). The checkout sends only the enabled ones.
// Reports price an order by its stored payment_type from midtrans.fees, so a switched-off method keeps its fee; a QRIS payment
// (payment_type qris) reads the fee of other_qris AND gopay (sql/reports.sql midtrans_method_codes): the GoPay tile arrives as qris.
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
