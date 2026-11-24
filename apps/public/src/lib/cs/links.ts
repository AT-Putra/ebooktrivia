// The two links of the help block (components/help/help-card.tsx). Only the order CODE (what the buyer already sees on the page and may quote
// to CS) is ever put in a prefilled text or a subject: never the buyer's name, e-mail address or phone number, and never the order's public
// id (the page's capability), so nothing personal travels in a URL.
import { csWaMeDigits } from "@ebooktrivia/core/cs-contact";
import { t } from "../t.ts";

/** https://wa.me/<digits>?text=<prefilled>: "Halo CS, saya butuh bantuan." and, on the order page, "... untuk pesanan <code>." */
export function csWhatsappHref(whatsapp: string, orderCode?: string): string {
  const text = orderCode === undefined ? t("help.whatsappText") : t("help.whatsappTextOrder", { ref: orderCode });
  return `https://wa.me/${csWaMeDigits(whatsapp)}?text=${encodeURIComponent(text)}`;
}

/** mailto:<address>?subject=<...>: "Butuh bantuan" and, on the order page, "Butuh bantuan untuk pesanan <code>". */
export function csMailHref(email: string, orderCode?: string): string {
  const subject = orderCode === undefined ? t("help.emailSubject") : t("help.emailSubjectOrder", { ref: orderCode });
  // The one @ stays as it is; everything else that is not safe in a mailto address (? & # % + space) is percent-encoded.
  return `mailto:${encodeURIComponent(email).replace("%40", "@")}?subject=${encodeURIComponent(subject)}`;
}
