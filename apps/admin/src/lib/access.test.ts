import { describe, expect, it } from "vitest";
import { decide, type RequireOptions } from "./access.ts";
import type { AdminIdentity } from "./auth/session.ts";

const staff: AdminIdentity = { userId: "s", sessionId: "x", role: "staff", displayName: "S" };
const owner: AdminIdentity = { ...staff, userId: "o", role: "owner" };

describe("decide (requireAdmin)", () => {
  it("sends anonymous requests to sign-in, whatever they ask for", () => {
    for (const options of [{ permission: "dashboard.view" }, { enrollment: true }, { allowUnenrolled: true }] as const) {
      expect(decide({ status: "anonymous" }, options)).toEqual({ kind: "redirect", to: "/login" });
    }
  });

  it("keeps an un-enrolled session on the enrollment page", () => {
    expect(decide({ status: "unenrolled", admin: owner }, { permission: "dashboard.view" })).toEqual({ kind: "redirect", to: "/enroll" });
    expect(decide({ status: "unenrolled", admin: owner }, { permission: "audit.view" })).toEqual({ kind: "redirect", to: "/enroll" });
    expect(decide({ status: "unenrolled", admin: owner }, { enrollment: true })).toEqual({ kind: "allow", admin: owner });
  });

  it("lets sign-out (allowUnenrolled) through for both kinds of session, never for anonymous", () => {
    expect(decide({ status: "unenrolled", admin: owner }, { allowUnenrolled: true })).toEqual({ kind: "allow", admin: owner });
    expect(decide({ status: "active", admin: staff }, { allowUnenrolled: true })).toEqual({ kind: "allow", admin: staff });
  });

  it("sends an enrolled session past the enrollment page", () => {
    expect(decide({ status: "active", admin: staff }, { enrollment: true })).toEqual({ kind: "redirect", to: "/" });
  });

  it("applies the policy to active sessions", () => {
    expect(decide({ status: "active", admin: staff }, { permission: "reports.view" })).toEqual({ kind: "allow", admin: staff });
    expect(decide({ status: "active", admin: staff }, { permission: "admin_user.manage" })).toEqual({ kind: "forbidden" });
    expect(decide({ status: "active", admin: staff }, { permission: "midtrans.edit" })).toEqual({ kind: "forbidden" });
    expect(decide({ status: "active", admin: owner }, { permission: "admin_user.manage" })).toEqual({ kind: "allow", admin: owner });
  });

  it("keeps a session whose password is in a known breach on the change page, Owner and Staff alike (US-031)", () => {
    for (const admin of [owner, staff]) {
      for (const permission of ["dashboard.view", "account.manage_own", "admin_user.manage"] as const) {
        expect(decide({ status: "password_change", admin }, { permission })).toEqual({ kind: "redirect", to: "/change-password" });
      }
      expect(decide({ status: "password_change", admin }, { enrollment: true })).toEqual({ kind: "redirect", to: "/change-password" });
      expect(decide({ status: "password_change", admin }, { passwordChange: true })).toEqual({ kind: "allow", admin });
      expect(decide({ status: "password_change", admin }, { allowUnenrolled: true })).toEqual({ kind: "allow", admin });
    }
    // Nobody else reaches the change page: an active session goes on to the console, an un-enrolled one to enrolment.
    expect(decide({ status: "active", admin: staff }, { passwordChange: true })).toEqual({ kind: "redirect", to: "/" });
    expect(decide({ status: "unenrolled", admin: staff }, { passwordChange: true })).toEqual({ kind: "redirect", to: "/enroll" });
    expect(decide({ status: "anonymous" }, { passwordChange: true })).toEqual({ kind: "redirect", to: "/login" });
  });

  it("refuses an active session when a caller bypassed the type and gave no requirement", () => {
    expect(decide({ status: "active", admin: owner }, {} as RequireOptions)).toEqual({ kind: "forbidden" });
  });
});
