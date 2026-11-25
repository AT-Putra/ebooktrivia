// The order page's view of an order: the DB status mapped to a page state, and the only fields the page
// ever shows. The buyer's name and phone arrive MASKED from the database (get_order_status returns only
// public.mask_name / public.mask_phone, the product's one masking rule) and the e-mail is never read,
// so nothing unmasked exists in this process, the HTML, the page's props or an API answer.
import type { OrderStatus } from "@ebooktrivia/core";
import { PAID_PAGE_DEFAULTS, type PaidPageWording } from "@ebooktrivia/core/paid-page";
import { t } from "../t.ts";
import type { PageState } from "./contract.ts";
import type { OrderRecord } from "./data.ts";
import { type Vendor, vendorsOf } from "./vendors.ts";

/** The play app's OTP login (US-026), where the page's call to action leads. */
export const PLAY_LOGIN_PATH = "/login";

/** Every order status has a page state: a status added to the enum fails this type until it is mapped. */
const STATE_OF_STATUS: Readonly<Record<OrderStatus, PageState>> = {
  pending: "pending",
  paid: "paid",
  expired: "expired",
  gateway_failed: "failed",
  snap_create_failed: "failed",
  review: "review",
  refunded: "refunded",
};

/** A status this code does not know (a newer enum value) shows as pending: the poll keeps asking. */
export const pageState = (dbStatus: string): PageState => (Object.hasOwn(STATE_OF_STATUS, dbStatus) ? STATE_OF_STATUS[dbStatus as OrderStatus] : "pending");

export interface OrderView {
  readonly state: PageState;
  readonly code: string;
  readonly name: string;
  readonly phone: string;
  readonly product: string;
  readonly amountIdr: number;
  /** The wa.me link with the order code in its text; null when no pool number is known. */
  readonly whatsappHref: string | null;
  /** The paid page's wa.me link: asks for the ebook and the trivia access, with the order code our number needs (buyer-first, no opener). */
  readonly whatsappPaidHref: string | null;
  /** The paid page's texts (the Owner's wording, or the defaults). */
  readonly paidWording: PaidPageWording;
  /** Back to the landing page the buyer came from ("order again" / "try again"); null when it has no host. */
  readonly orderAgainHref: string | null;
  /** The OTP login on the play origin (the page carries no login token: the link was sent by WhatsApp and e-mail). */
  readonly loginHref: string;
  /** The vendors that have a pixel id: whether the page has anything to claim once the order is paid. */
  readonly vendors: readonly Vendor[];
}

export function whatsappHref(poolDigits: string | undefined, code: string, product: string, key: "order.whatsappText" | "order.whatsappTextPaid" = "order.whatsappText"): string | null {
  if (poolDigits === undefined) return null;
  return `https://wa.me/${poolDigits}?text=${encodeURIComponent(t(key, { ref: code, product }))}`;
}

export function toView(record: OrderRecord, poolDigits: string | undefined, domain: string, paidWording: PaidPageWording = PAID_PAGE_DEFAULTS): OrderView {
  return {
    state: pageState(record.status),
    code: record.orderCode,
    name: record.maskedName,
    phone: record.maskedPhone,
    product: record.productTitle,
    amountIdr: record.amountIdr,
    whatsappHref: whatsappHref(poolDigits, record.orderCode, record.productTitle),
    whatsappPaidHref: whatsappHref(poolDigits, record.orderCode, record.productTitle, "order.whatsappTextPaid"),
    paidWording,
    orderAgainHref: record.lpHost === null ? null : `https://${record.lpHost}/`,
    loginHref: `https://play.${domain}${PLAY_LOGIN_PATH}`,
    vendors: vendorsOf(record.pixels),
  };
}
