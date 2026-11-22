// Structural guard (plan M5a.1: requireAdmin on every layout, action and handler; code review
// US-016 CM2). Fails when:
//   - a page.tsx / layout.tsx is not on the public list and does not call requireAdmin with exactly
//     the requirement listed in GUARDS below;
//   - a server-action module exports anything but `adminAction({ <requirement> }, ...)` (or
//     `authAction(...)` for the sign-in steps), each with the requirement listed in GUARDS;
//   - a route.ts exports a method that is not `adminRoute({ <requirement> }, ...)` as listed;
//   - GUARDS lists something that no longer exists (keep the table exact);
//   - the server-action directive appears anywhere but as the first statement of a file;
//   - anything mounts Better Auth's HTTP handler.
// A requirement is `permission:<policy permission>`, `enrollment` or `allowUnenrolled`; an empty
// `{}` or a missing argument is rejected here and is a type error (lib/access.ts RequireOptions).
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../lib/policy.ts";

const appDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(appDir, "..");
const posix = (p: string) => p.split("\\").join("/");
const filesUnder = (dir: string) => readdirSync(dir, { recursive: true, encoding: "utf8" }).map((p) => join(dir, p));
const appFiles = filesUnder(appDir).map((p) => posix(relative(appDir, p)));
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

/** What every guarded page, layout, action and route requires (paths relative to src/app). */
const GUARDS: Readonly<Record<string, string>> = {
  "(console)/layout.tsx": "permission:dashboard.view",
  "(console)/page.tsx": "permission:dashboard.view",
  "(console)/team/page.tsx": "permission:admin_user.manage",
  "(console)/audit/page.tsx": "permission:audit.view",
  "(console)/account/page.tsx": "permission:account.manage_own",
  "(auth)/enroll/page.tsx": "enrollment",
  "(auth)/login/actions.ts#signInAction": "auth",
  "(auth)/login/actions.ts#verifyTotpAction": "auth",
  "(auth)/login/actions.ts#verifyRecoveryCodeAction": "auth",
  "(auth)/enroll/actions.ts#startEnrollmentAction": "enrollment",
  "(auth)/enroll/actions.ts#completeEnrollmentAction": "enrollment",
  "(console)/team/actions.ts#createStaffAction": "permission:admin_user.manage",
  "(console)/team/actions.ts#setDisabledAction": "permission:admin_user.manage",
  "(console)/team/actions.ts#resetAccessAction": "permission:admin_user.manage",
  "(console)/account/actions.ts#regenerateRecoveryCodesAction": "permission:account.manage_own",
  "auth/sign-out/route.ts#POST": "allowUnenrolled",
  // Settings (US-017): Staff = AC-A1 content only (products, landing-page name, templates);
  // everything else Owner-only.
  "(console)/settings/programs/page.tsx": "permission:program.edit",
  "(console)/settings/products/page.tsx": "permission:product.content.edit",
  "(console)/settings/landing-pages/page.tsx": "permission:landing_page.content.edit",
  "(console)/settings/adnets/page.tsx": "permission:adnet.edit",
  "(console)/settings/midtrans/page.tsx": "permission:midtrans.edit",
  "(console)/settings/waha/page.tsx": "permission:waha.edit",
  "(console)/settings/smtp/page.tsx": "permission:smtp.edit",
  "(console)/settings/templates/page.tsx": "permission:message_template.edit",
  "(console)/settings/programs/actions.ts#createProgramAction": "permission:program.edit",
  "(console)/settings/programs/actions.ts#updateProgramAction": "permission:program.edit",
  "(console)/settings/programs/actions.ts#rescheduleProgramAction": "permission:program.reschedule",
  "(console)/settings/programs/actions.ts#setProgramStatusAction": "permission:program.edit",
  "(console)/settings/programs/actions.ts#cloneProgramAction": "permission:program.edit",
  "(console)/settings/products/actions.ts#createProductAction": "permission:product.price.edit",
  "(console)/settings/products/actions.ts#renameProductAction": "permission:product.content.edit",
  "(console)/settings/products/actions.ts#updateProductCommerceAction": "permission:product.price.edit",
  "(console)/settings/landing-pages/actions.ts#createLandingPageAction": "permission:landing_page.settings.edit",
  "(console)/settings/landing-pages/actions.ts#renameLandingPageAction": "permission:landing_page.content.edit",
  "(console)/settings/landing-pages/actions.ts#updateLandingPageSettingsAction": "permission:landing_page.settings.edit",
  "(console)/settings/landing-pages/actions.ts#updatePixelsAction": "permission:pixel.edit",
  "(console)/settings/landing-pages/actions.ts#setCapiTokenAction": "permission:pixel.edit",
  "(console)/settings/landing-pages/actions.ts#clearCapiTokenAction": "permission:pixel.edit",
  "(console)/settings/landing-pages/actions.ts#registerDomainAction": "permission:lp_domain.register",
  "(console)/settings/landing-pages/actions.ts#removeDomainAction": "permission:lp_domain.register",
  "(console)/settings/landing-pages/actions.ts#activateLpVersionAction": "permission:lp_zip.publish",
  "(console)/settings/landing-pages/actions.ts#stopLpHostingAction": "permission:lp_zip.publish",
  "(console)/settings/adnets/actions.ts#createAdnetAction": "permission:adnet.edit",
  "(console)/settings/adnets/actions.ts#updateAdnetAction": "permission:adnet.edit",
  "(console)/settings/adnets/actions.ts#setAdnetSecretAction": "permission:adnet.edit",
  "(console)/settings/adnets/actions.ts#clearAdnetSecretAction": "permission:adnet.edit",
  "(console)/settings/midtrans/actions.ts#updateMidtransMethodsAction": "permission:midtrans.edit",
  "(console)/settings/midtrans/actions.ts#setMidtransEnvironmentAction": "permission:midtrans.edit",
  "(console)/settings/midtrans/actions.ts#setMidtransKeyAction": "permission:midtrans.edit",
  "(console)/settings/midtrans/actions.ts#clearMidtransKeyAction": "permission:midtrans.edit",
  "(console)/settings/waha/actions.ts#createWahaServerAction": "permission:waha.edit",
  "(console)/settings/waha/actions.ts#updateWahaServerAction": "permission:waha.edit",
  "(console)/settings/waha/actions.ts#setWahaApiKeyAction": "permission:waha.edit",
  "(console)/settings/waha/actions.ts#clearWahaApiKeyAction": "permission:waha.edit",
  "(console)/settings/waha/actions.ts#createWahaSessionAction": "permission:waha.edit",
  "(console)/settings/waha/actions.ts#updateWahaSessionAction": "permission:waha.edit",
  "(console)/settings/smtp/actions.ts#saveSmtpAction": "permission:smtp.edit",
  "(console)/settings/smtp/actions.ts#setSmtpPasswordAction": "permission:smtp.edit",
  "(console)/settings/smtp/actions.ts#clearSmtpPasswordAction": "permission:smtp.edit",
  "(console)/settings/templates/actions.ts#updateTemplateAction": "permission:message_template.edit",
  "(console)/settings/templates/actions.ts#previewTemplateAction": "permission:message_template.edit",
  "(console)/settings/templates/actions.ts#testSendTemplateAction": "permission:message_template.test_send",
  "(console)/settings/templates/actions.ts#addTestRecipientAction": "permission:test_recipient.manage",
  "(console)/settings/templates/actions.ts#removeTestRecipientAction": "permission:test_recipient.manage",
  "uploads/pdf/init/route.ts#POST": "permission:product.content.edit",
  "uploads/pdf/chunk/route.ts#POST": "permission:product.content.edit",
  "uploads/pdf/complete/route.ts#POST": "permission:product.content.edit",
  // Trivia content (US-018): manage trivia is Staff (AC-A1); the content lock on top is decided
  // inside each change (Staff on a set with attempts -> 403). Scoring override, prize tiers, legal
  // pages and OTP / rate limits are Owner-only (owner decision 2026-11-18).
  "(console)/settings/trivia/page.tsx": "permission:trivia_set.edit",
  "(console)/settings/trivia/[programId]/page.tsx": "permission:trivia_set.edit",
  "(console)/settings/trivia/[programId]/[setId]/page.tsx": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#createSetAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#renameSetAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#moveSetAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#deleteSetAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#removeSetThumbnailAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#createQuestionAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#updateQuestionAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#deleteQuestionAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#removeQuestionImageAction": "permission:trivia_set.edit",
  "(console)/settings/trivia/actions.ts#overrideScoringAction": "permission:rescore.override",
  // Contest results (US-028): the page is a report (Staff see it); confirming winners and the
  // deadline extension are Owner-only.
  "(console)/settings/trivia/[programId]/results/page.tsx": "permission:reports.view",
  "(console)/settings/trivia/actions.ts#confirmWinnersAction": "permission:winners.confirm",
  "(console)/settings/trivia/actions.ts#extendDeadlinesAction": "permission:contest.extend_deadlines",
  "uploads/image/trivia/route.ts#POST": "permission:trivia_set.edit",
  "uploads/questions/route.ts#POST": "permission:trivia_set.edit",
  "(console)/settings/prizes/page.tsx": "permission:prize_tier.edit",
  "(console)/settings/prizes/actions.ts#createPrizeTierAction": "permission:prize_tier.edit",
  "(console)/settings/prizes/actions.ts#updatePrizeTierAction": "permission:prize_tier.edit",
  "(console)/settings/prizes/actions.ts#deletePrizeTierAction": "permission:prize_tier.edit",
  "(console)/settings/prizes/actions.ts#removePrizeImageAction": "permission:prize_tier.edit",
  "uploads/image/prize/route.ts#POST": "permission:prize_tier.edit",
  "uploads/lp-zip/init/route.ts#POST": "permission:lp_zip.publish",
  "uploads/lp-zip/chunk/route.ts#POST": "permission:lp_zip.publish",
  "uploads/lp-zip/complete/route.ts#POST": "permission:lp_zip.publish",
  "(console)/settings/legal/page.tsx": "permission:legal_page.edit",
  "(console)/settings/legal/[programId]/page.tsx": "permission:legal_page.edit",
  "(console)/settings/legal/actions.ts#saveLegalDraftAction": "permission:legal_page.edit",
  "(console)/settings/legal/actions.ts#publishLegalPageAction": "permission:legal_page.edit",
  "(console)/settings/limits/page.tsx": "permission:app_settings.edit",
  "(console)/settings/limits/actions.ts#saveLimitsAction": "permission:app_settings.edit",
  // Reports (US-029): Staff view the dashboard, sales, delivery, postback and contest reports (reports.view, no export); the profit
  // view, ad spend, the re-fire and both CSV exports are Owner-only, so a Staff session is refused by the route itself.
  "(console)/reports/sales/page.tsx": "permission:reports.view",
  "(console)/reports/sales/export/route.ts#POST": "permission:sales.export",
  "(console)/reports/delivery/page.tsx": "permission:reports.view",
  "(console)/reports/delivery/actions.ts#resendDeliveryAction": "permission:delivery.resend",
  "(console)/reports/delivery/actions.ts#resendUnknownDeliveryAction": "permission:delivery.resend_unknown",
  "(console)/reports/delivery/actions.ts#markWrongFileHandledAction": "permission:delivery.wrong_file_handled",
  "(console)/reports/postbacks/page.tsx": "permission:reports.view",
  "(console)/reports/postbacks/actions.ts#refireConversionAction": "permission:conversion.refire",
  "(console)/reports/contest/page.tsx": "permission:reports.view",
  "(console)/reports/contest/export/route.ts#POST": "permission:winners.export",
  "(console)/reports/roi/page.tsx": "permission:roi.view",
  "(console)/reports/ad-spend/page.tsx": "permission:ad_spend.edit",
  "(console)/reports/ad-spend/actions.ts#createAdSpendAction": "permission:ad_spend.edit",
  "(console)/reports/ad-spend/actions.ts#updateAdSpendAction": "permission:ad_spend.edit",
  "(console)/reports/ad-spend/actions.ts#deleteAdSpendAction": "permission:ad_spend.edit",
  // Prize fulfilment and UU PDP deletion (US-030): Owner-only; Staff are refused by every page, action and route (403).
  "(console)/fulfillment/page.tsx": "permission:prize_fulfillment.update",
  "(console)/fulfillment/[programId]/page.tsx": "permission:prize_fulfillment.update",
  "(console)/fulfillment/actions.ts#advanceFulfillmentAction": "permission:prize_fulfillment.update",
  "(console)/fulfillment/actions.ts#correctFulfillmentAction": "permission:prize_fulfillment.update",
  "(console)/fulfillment/actions.ts#saveFulfillmentNotesAction": "permission:prize_fulfillment.update",
  "(console)/fulfillment/actions.ts#revokeWinnerAction": "permission:winners.reaward",
  "(console)/fulfillment/actions.ts#reinstateWinnerAction": "permission:winners.reaward",
  "(console)/fulfillment/proof/route.ts#POST": "permission:prize_fulfillment.update",
  "uploads/proof/route.ts#POST": "permission:prize_fulfillment.update",
  "(console)/privacy/page.tsx": "permission:deletion_request.process",
  "(console)/privacy/[requestId]/page.tsx": "permission:deletion_request.process",
  "(console)/privacy/actions.ts#createDeletionRequestAction": "permission:deletion_request.process",
  "(console)/privacy/actions.ts#executeDeletionRequestAction": "permission:deletion_request.process",
  "(console)/privacy/actions.ts#rejectDeletionRequestAction": "permission:deletion_request.process",
  // The Owner's review queue for orders (US-033): the page, the decisions, the re-query and the buyer's details are Owner-only.
  "(console)/orders/review/page.tsx": "permission:order.review.resolve",
  "(console)/orders/review/actions.ts#decideReviewAction": "permission:order.review.resolve",
  "(console)/orders/review/actions.ts#requeryReviewAction": "permission:order.review.resolve",
  "(console)/orders/review/actions.ts#revealBuyerAction": "permission:order.review.resolve",
};

/** Pages / layouts reachable without a console session, with the reason. */
const PUBLIC: Readonly<Record<string, string>> = {
  "layout.tsx": "root layout: html shell only",
  "(auth)/login/page.tsx": "sign-in step 1",
  "(auth)/login/two-factor/page.tsx": "sign-in step 2 (needs the password step's challenge cookie)",
  "(auth)/login/recovery/page.tsx": "sign-in step 2 with a recovery code",
};
const isMockup = (rel: string) => rel.startsWith("(mockups)/");

/** `{ permission: "x" }` -> permission:x, `{ enrollment: true }`, `{ allowUnenrolled: true }`; else "invalid". */
function requirement(literal: string): string {
  const body = literal.replace(/\s+/g, " ").trim();
  const permission = /^\{ ?permission: "([a-z_.]+)" ?\}$/.exec(body)?.[1];
  if (permission !== undefined) return (PERMISSIONS as readonly string[]).includes(permission) ? `permission:${permission}` : "invalid";
  if (/^\{ ?enrollment: true ?\}$/.test(body)) return "enrollment";
  if (/^\{ ?allowUnenrolled: true ?\}$/.test(body)) return "allowUnenrolled";
  return "invalid";
}

const pagesAndLayouts = appFiles.filter((p) => ["page.tsx", "layout.tsx"].includes(basename(p)));
const routes = appFiles.filter((p) => basename(p) === "route.ts");
const srcFiles = filesUnder(srcDir)
  .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))
  .map((p) => ({ rel: posix(relative(srcDir, p)), text: readFileSync(p, "utf8") }));
/** The directive anywhere on a line, in code or comments (comments must not quote it). */
const DIRECTIVE = /["']use server["']/g;
const serverFiles = srcFiles.filter((f) => (f.text.match(DIRECTIVE) ?? []).length > 0).map((f) => f.rel.replace(/^app\//, ""));

/** Every guard actually found in the sources, as GUARDS keys -> requirement. */
function foundGuards(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const rel of pagesAndLayouts) {
    if (PUBLIC[rel] !== undefined || isMockup(rel)) continue;
    const calls = [...read(rel).matchAll(/await requireAdmin\(([^)]*)\)/g)].map((m) => requirement(m[1] ?? ""));
    found[rel] = calls.length === 1 ? (calls[0] ?? "invalid") : `${String(calls.length)} calls`;
  }
  for (const rel of serverFiles) {
    for (const line of read(rel).split("\n").filter((l) => /^export\b/.test(l))) {
      const name = /^export const (\w+) = /.exec(line)?.[1] ?? line;
      const admin = /^export const \w+ = adminAction\((\{[^}]*\}),/.exec(line)?.[1];
      found[`${rel}#${name}`] = admin !== undefined ? requirement(admin) : /^export const \w+ = authAction\(async /.test(line) ? "auth" : "invalid";
    }
  }
  for (const rel of routes) {
    for (const line of read(rel).split("\n").filter((l) => /^export\b/.test(l))) {
      const method = /^export const (GET|HEAD|POST|PUT|PATCH|DELETE) = /.exec(line)?.[1] ?? line;
      const literal = /^export const [A-Z]+ = adminRoute\((\{[^}]*\}),/.exec(line)?.[1];
      found[`${rel}#${method}`] = literal === undefined ? "invalid" : requirement(literal);
    }
  }
  return found;
}

describe("guards", () => {
  it("are found", () => {
    expect(Object.keys(foundGuards()).length).toBeGreaterThan(10);
  });

  it("match the table exactly: every page, layout, action and route with its requirement", () => {
    expect(foundGuards()).toEqual(GUARDS);
  });

  it("only the sign-in steps use authAction, and only in (auth)/login", () => {
    for (const [key, value] of Object.entries(GUARDS)) if (value === "auth") expect(key.startsWith("(auth)/login/actions.ts#"), key).toBe(true);
  });

  it.each(Object.keys(PUBLIC))("public %s still exists (keep the list exact)", (rel) => {
    expect(pagesAndLayouts).toContain(rel);
  });

  it.each(pagesAndLayouts.filter(isMockup))("mockup %s is guarded by the mockup flag instead", (rel) => {
    expect(read(rel)).toContain("assertMockupsEnabled();");
  });

  it("parses requirements strictly", () => {
    expect(requirement('{ permission: "audit.view" }')).toBe("permission:audit.view");
    expect(requirement("{ enrollment: true }")).toBe("enrollment");
    expect(requirement("{}")).toBe("invalid");
    expect(requirement("")).toBe("invalid");
    expect(requirement('{ permission: "not.a_permission" }')).toBe("invalid");
    expect(requirement('{ permission: "audit.view", enrollment: true }')).toBe("invalid");
  });
});

describe("server-action directive", () => {
  it("is found in every server-action module", () => {
    expect(serverFiles.sort()).toEqual([
      "(auth)/enroll/actions.ts",
      "(auth)/login/actions.ts",
      "(console)/account/actions.ts",
      "(console)/fulfillment/actions.ts",
      "(console)/orders/review/actions.ts",
      "(console)/privacy/actions.ts",
      "(console)/reports/ad-spend/actions.ts",
      "(console)/reports/delivery/actions.ts",
      "(console)/reports/postbacks/actions.ts",
      "(console)/settings/adnets/actions.ts",
      "(console)/settings/landing-pages/actions.ts",
      "(console)/settings/legal/actions.ts",
      "(console)/settings/limits/actions.ts",
      "(console)/settings/midtrans/actions.ts",
      "(console)/settings/prizes/actions.ts",
      "(console)/settings/products/actions.ts",
      "(console)/settings/programs/actions.ts",
      "(console)/settings/smtp/actions.ts",
      "(console)/settings/templates/actions.ts",
      "(console)/settings/trivia/actions.ts",
      "(console)/settings/waha/actions.ts",
      "(console)/team/actions.ts",
    ]);
  });

  it.each(srcFiles.filter((f) => (f.text.match(DIRECTIVE) ?? []).length > 0).map((f) => f.rel))("%s has it once, as the first statement (no inline server functions)", (rel) => {
    const text = srcFiles.find((f) => f.rel === rel)?.text ?? "";
    expect(text.match(DIRECTIVE)).toHaveLength(1);
    expect(text.startsWith('"use server";\n')).toBe(true);
  });
});

describe("route handlers", () => {
  it("never offer state changes on GET (mutations are POST-only route handlers or server actions)", () => {
    for (const rel of routes) expect(read(rel), rel).not.toMatch(/^export const GET = /m);
  });
});

describe("Better Auth", () => {
  it("its HTTP handler is mounted nowhere (the console calls auth.api from its own actions)", () => {
    for (const file of srcFiles) {
      expect(file.text, file.rel).not.toMatch(/toNextJsHandler|auth\.handler\b|\.handler\(\s*request/);
    }
  });

  it("only lib/auth/service.ts and lib/auth/session.ts call auth.api", () => {
    const callers = srcFiles.filter((f) => /\.auth\.api\./.test(f.text)).map((f) => f.rel);
    expect(callers.sort()).toEqual(["lib/auth/service.ts", "lib/auth/session.ts"]);
  });
});

describe("sealed secrets (plan M2.3: the admin process cannot decrypt)", () => {
  it("no admin source uses the opener side of @ebooktrivia/crypto", () => {
    for (const file of srcFiles) expect(file.text, file.rel).not.toMatch(/\b(?:createSecretOpener|openerFromEnv|openSecret|openOtp|SecretOpener)\b/);
  });

  it("admin sources import the sealer subpath only; the full upload policy (sharp) only where images and imports are checked", () => {
    // US-018: content images are re-encoded with sharp and imports go through inspectZip, both in
    // @ebooktrivia/uploads; every other module keeps to the PDF-only subpath. Nothing imports sharp itself.
    // US-030: a fulfilment proof is checked (and an image re-encoded) by the same policy, in its own module.
    const fullUploads = ["lib/settings/fulfillment-proof.ts", "lib/settings/images.ts", "lib/settings/trivia-import.ts"];
    for (const file of srcFiles) {
      expect(file.text, file.rel).not.toMatch(/from "@ebooktrivia\/crypto"|import\("@ebooktrivia\/crypto"\)/);
      expect(file.text, file.rel).not.toMatch(/from "sharp"/);
      if (!fullUploads.includes(file.rel)) expect(file.text, file.rel).not.toMatch(/from "@ebooktrivia\/uploads"/);
    }
    expect(srcFiles.filter((f) => /from "@ebooktrivia\/uploads"/.test(f.text)).map((f) => f.rel).sort()).toEqual(fullUploads);
  });

  // Code review US-018 F10: a page (with everything it imports, its server actions included) never
  // loads the import parser or the image pipeline; only the upload route handlers do.
  it("no page or layout loads exceljs, papaparse or sharp, directly or through what it imports", () => {
    const HEAVY = /from "(?:exceljs|papaparse|sharp|@ebooktrivia\/uploads)"/;
    const IMPORT = /^(?:import|export)\s+(?!type\s)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm;
    for (const entry of pagesAndLayouts) {
      const seen = new Set<string>();
      const queue = [join(appDir, entry)];
      for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        expect(HEAVY.test(text), `${entry} loads ${posix(relative(srcDir, file))}`).toBe(false);
        for (const m of text.matchAll(IMPORT)) queue.push(join(dirname(file), m[1] ?? ""));
      }
      expect(seen.size, entry).toBeGreaterThan(0);
    }
  });

  it("no admin source reads a sealed column", () => {
    for (const file of srcFiles) expect(file.text, file.rel).not.toMatch(/SELECT[^`]*\b(?:ciphertext|sealed_dek|sealed_code|sealed)\b[^`]*FROM/is);
  });
});
