// Admin authorization (AC-A1, plan M5a.3). The one place that decides what a role may do: pages,
// server actions and route handlers ask `requireAdmin({ permission })` (lib/next/require-admin.ts),
// and the console hides every control whose permission `can` denies.
//
// Staff get exactly AC-A1's four groups: manage content, manage trivia, resends, view reports.
// Everything else is Owner-only (owner decision D1, US-016 review: everything beyond AC-A1 stays
// Owner-only, legal pages included), in particular the plan's explicit denials: every integration secret
// (gateway / postback / CAPI / SMTP / WAHA), prices, buyer exports, the winners export, LP domain
// registration and question content on locked sets (§10 item 18). The database still refuses
// structural edits of locked questions for everyone (content lock triggers ET020/ET021).
// Unknown roles and unknown permissions are denied.

export const ROLES = ["owner", "staff"] as const;
export type Role = (typeof ROLES)[number];

/** owner: Owner only. staff: Owner and Staff. staff_unlocked: Staff only while the set is unlocked. */
type Rule = "owner" | "staff" | "staff_unlocked";

const RULES = {
  // View reports (AC-A1), and the signed-in user's own account (recovery codes, sign out).
  "dashboard.view": "staff",
  "reports.view": "staff",
  "account.manage_own": "staff",
  // Manage content (AC-A1).
  "product.content.edit": "staff",
  "landing_page.content.edit": "staff",
  "message_template.edit": "staff",
  "message_template.test_send": "staff",
  // Who test-sends may reach (security review US-017 S4): the Owner's list, not content.
  "test_recipient.manage": "owner",
  // Manage trivia (AC-A1); locked sets are Owner-only (§10 item 18).
  "trivia_set.edit": "staff",
  "question.content.edit": "staff_unlocked",
  "question.import": "staff_unlocked",
  // Resends (AC-A1).
  "delivery.resend": "staff",
  // Secrets (AC-A1): gateway, postback, CAPI, SMTP, WAHA settings.
  "midtrans.edit": "owner",
  "adnet.edit": "owner",
  "pixel.edit": "owner",
  "smtp.edit": "owner",
  "waha.edit": "owner",
  // Prices (AC-A1).
  "product.price.edit": "owner",
  // Exports: buyer data (AC-A1), the sales CSV (AC-A5), winners (plan M5a.3).
  "buyer.export": "owner",
  "sales.export": "owner",
  "winners.export": "owner",
  // LP domain registration (§10 item 18).
  "lp_domain.register": "owner",
  // Publishing a landing-page ZIP and switching its live version (US-023): the files become a public site
  // that runs scripts next to the checkout on a registered domain, so it is the domain owner's call, not
  // AC-A1 "content" (product texts, templates, trivia). Owner only.
  "lp_zip.publish": "owner",
  // Creating a landing page and binding it to a program / gateway / allowed adnets (US-017): not
  // content, so Owner-only. Staff may rename it (landing_page.content.edit).
  "landing_page.settings.edit": "owner",
  // Not granted to Staff by AC-A1, so Owner-only.
  "program.edit": "owner",
  "program.reschedule": "owner",
  "prize_tier.edit": "owner",
  "legal_page.edit": "owner",
  "winners.confirm": "owner",
  // The deadline-extension tool for outages (US-028, plan §10 item 16): changes contest timing.
  "contest.extend_deadlines": "owner",
  "prize_fulfillment.update": "owner",
  // US-030: revoke a winner and re-award the prize to the next eligible rank, or reinstate a flagged one (a chargeback).
  "winners.reaward": "owner",
  "rescore.override": "owner",
  "deletion_request.process": "owner",
  "conversion.refire": "owner",
  "delivery.mark_unknown_sent": "owner",
  // Resending a delivery that MAY already have reached the buyer (an unknown send), after the Owner's explicit confirmation (US-025): a failed delivery is
  // `delivery.resend` (Staff, AC-A1), an unknown one can duplicate the ebook or a login link, so it is not covered by AC-A1's "resends" for Staff.
  "delivery.resend_unknown": "owner",
  // Marking a `sent` delivery whose WhatsApp file arrived wrong (last_error delivered_wrong_file, US-005 R11) as handled, which takes it off the "Needs attention" list. Display only:
  // it changes nothing about the delivery (a sent row stays final) and is audited. The Owner reads the note and decides, so it is the Owner's.
  "delivery.wrong_file_handled": "owner",
  "order.review.resolve": "owner",
  "ad_spend.edit": "owner",
  // The profit / ROI view (US-029, AC-A8): it shows adnet payouts (CPA), gateway fees and ad spend, which are Owner-only
  // settings even to look at (adnet.edit, midtrans.edit, ad_spend.edit), so the view is Owner-only too. The other
  // reports (dashboard, sales, delivery, postbacks, trivia) are `reports.view` / `dashboard.view`: Staff.
  "roi.view": "owner",
  "app_settings.edit": "owner",
  // Where the worker sends the Owner's alerts, and the test alert (US-015): the Owner's own number and address.
  "alert_recipients.edit": "owner",
  // The open alerts, and marking a handled group of them resolved (Owner decision 2026-11-25: an alert could not be closed once its cause was fixed).
  // Not granted to Staff by AC-A1, so Owner-only, like the recipients.
  "alerts.view": "owner",
  "alerts.resolve": "owner",
  // The customer-service contact buyers are shown on every page and in a few WhatsApp replies (Owner decision 2026-11-24): the Owner's own number, address and hours.
  "cs_contact.edit": "owner",
  "admin_user.manage": "owner",
  "audit.view": "owner",
} as const satisfies Record<string, Rule>;

export type Permission = keyof typeof RULES;
/** Permissions whose answer depends on whether the trivia set is locked (has attempts). */
export type QuestionPermission = { [P in Permission]: (typeof RULES)[P] extends "staff_unlocked" ? P : never }[Permission];
export interface QuestionContext {
  /** The set has at least one attempt (content lock). */
  readonly setLocked: boolean;
}

export const PERMISSIONS: readonly Permission[] = Object.keys(RULES) as Permission[];

const RULE_BY_PERMISSION = new Map<string, Rule>(Object.entries(RULES));

export function can(role: Role, permission: Exclude<Permission, QuestionPermission>): boolean;
export function can(role: Role, permission: QuestionPermission, context: QuestionContext): boolean;
export function can(role: Role, permission: Permission, context?: QuestionContext): boolean {
  const rule = RULE_BY_PERMISSION.get(permission);
  if (rule === undefined) return false;
  // A role read from the database is checked at runtime too: anything but these two is denied.
  const actual: string = role;
  if (actual === "owner") return true;
  if (actual !== "staff") return false;
  switch (rule) {
    case "staff":
      return true;
    case "staff_unlocked":
      return context?.setLocked === false;
    case "owner":
      return false;
  }
}

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "staff";
}
