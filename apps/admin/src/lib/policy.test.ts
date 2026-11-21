import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, type Permission, type Role } from "./policy.ts";

// Expected values are written out here, independently of the rule table in policy.ts: Staff get
// exactly AC-A1's four groups (manage content, manage trivia, resends, view reports), every other
// permission is Owner-only. "unlocked" = allowed only while the trivia set has no attempts.
const STAFF_EXPECTED: Readonly<Record<Permission, boolean | "unlocked">> = {
  "dashboard.view": true,
  "reports.view": true,
  "account.manage_own": true,
  "product.content.edit": true,
  "landing_page.content.edit": true,
  "message_template.edit": true,
  "message_template.test_send": true,
  "test_recipient.manage": false,
  "trivia_set.edit": true,
  "question.content.edit": "unlocked",
  "question.import": "unlocked",
  "delivery.resend": true,
  "midtrans.edit": false,
  "adnet.edit": false,
  "pixel.edit": false,
  "smtp.edit": false,
  "waha.edit": false,
  "product.price.edit": false,
  "buyer.export": false,
  "sales.export": false,
  "winners.export": false,
  "lp_domain.register": false,
  "lp_zip.publish": false,
  "landing_page.settings.edit": false,
  "program.edit": false,
  "program.reschedule": false,
  "prize_tier.edit": false,
  "legal_page.edit": false,
  "winners.confirm": false,
  "contest.extend_deadlines": false,
  "prize_fulfillment.update": false,
  "rescore.override": false,
  "deletion_request.process": false,
  "conversion.refire": false,
  "delivery.mark_unknown_sent": false,
  "delivery.resend_unknown": false,
  "order.review.resolve": false,
  "ad_spend.edit": false,
  "roi.view": false,
  "app_settings.edit": false,
  "admin_user.manage": false,
  "audit.view": false,
};

const CONTEXTUAL = new Set<Permission>(["question.content.edit", "question.import"]);

function check(role: Role, permission: Permission, setLocked: boolean): boolean {
  // The overloads require a context for the two question permissions; the matrix test drives both.
  return CONTEXTUAL.has(permission)
    ? can(role, permission as "question.content.edit", { setLocked })
    : can(role, permission as "dashboard.view");
}

describe("policy matrix", () => {
  it("lists exactly the permissions the expected table covers", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(STAFF_EXPECTED).sort());
  });

  const cases = Object.entries(STAFF_EXPECTED).flatMap(([permission, staff]) =>
    [false, true].map((setLocked) => ({ permission: permission as Permission, staff, setLocked })),
  );

  it.each(cases)("owner may $permission (set locked: $setLocked)", ({ permission, setLocked }) => {
    expect(check("owner", permission, setLocked)).toBe(true);
  });

  it.each(cases)("staff: $permission (set locked: $setLocked) is $staff", ({ permission, staff, setLocked }) => {
    const expected = staff === "unlocked" ? !setLocked : staff;
    expect(check("staff", permission, setLocked)).toBe(expected);
  });
});

describe("plan denials for Staff (AC-A1, plan M5a.3, §10 item 18)", () => {
  it.each(["midtrans.edit", "adnet.edit", "pixel.edit", "smtp.edit", "waha.edit"] as const)(
    "cannot edit gateway / postback / CAPI / SMTP / WAHA secrets: %s",
    (permission) => {
      expect(can("staff", permission)).toBe(false);
    },
  );

  it("cannot edit prices", () => {
    expect(can("staff", "product.price.edit")).toBe(false);
  });

  it("cannot export buyer data, nor the sales CSV (AC-A5)", () => {
    expect(can("staff", "buyer.export")).toBe(false);
    expect(can("staff", "sales.export")).toBe(false);
  });

  it("cannot export winners", () => {
    expect(can("staff", "winners.export")).toBe(false);
  });

  it("cannot register LP domains, but may edit LP content", () => {
    expect(can("staff", "lp_domain.register")).toBe(false);
    expect(can("staff", "landing_page.content.edit")).toBe(true);
  });

  it("cannot edit or import question content on a locked set, but may on an unlocked one", () => {
    expect(can("staff", "question.content.edit", { setLocked: true })).toBe(false);
    expect(can("staff", "question.import", { setLocked: true })).toBe(false);
    expect(can("staff", "question.content.edit", { setLocked: false })).toBe(true);
    expect(can("staff", "question.import", { setLocked: false })).toBe(true);
  });

  it("cannot see the profit / ROI view (adnet payouts, gateway fees, ad spend), nor re-fire a conversion or edit ad spend (US-029)", () => {
    for (const permission of ["roi.view", "conversion.refire", "ad_spend.edit", "sales.export", "winners.export"] as const) {
      expect(can("staff", permission), permission).toBe(false);
      expect(can("owner", permission), permission).toBe(true);
    }
  });

  it("may resend deliveries and view reports (AC-A1)", () => {
    expect(can("staff", "delivery.resend")).toBe(true);
    expect(can("staff", "reports.view")).toBe(true);
    // ... but never a delivery that may already have reached the buyer: that is the Owner's, with a confirmation.
    expect(can("staff", "delivery.resend_unknown")).toBe(false);
    expect(can("owner", "delivery.resend_unknown")).toBe(true);
  });
});

describe("fail closed", () => {
  it("denies an unknown role", () => {
    expect(can("admin" as Role, "dashboard.view")).toBe(false);
    expect(can("" as Role, "dashboard.view")).toBe(false);
  });

  it("denies an unknown permission, even to the Owner", () => {
    expect(can("owner", "secrets.read" as "dashboard.view")).toBe(false);
    expect(can("owner", "__proto__" as "dashboard.view")).toBe(false);
    expect(can("owner", "toString" as "dashboard.view")).toBe(false);
  });

  it("denies Staff a contextual permission when the lock state is missing", () => {
    const unchecked = can as (role: Role, permission: Permission, context?: unknown) => boolean;
    expect(unchecked("staff", "question.content.edit")).toBe(false);
    expect(unchecked("staff", "question.import", {})).toBe(false);
    expect(unchecked("staff", "question.import", null)).toBe(false);
    expect(unchecked("staff", "question.import", { setLocked: "no" })).toBe(false);
  });
});
