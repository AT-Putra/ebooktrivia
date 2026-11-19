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

  it("refuses an active session when a caller bypassed the type and gave no requirement", () => {
    expect(decide({ status: "active", admin: owner }, {} as RequireOptions)).toEqual({ kind: "forbidden" });
  });
});
