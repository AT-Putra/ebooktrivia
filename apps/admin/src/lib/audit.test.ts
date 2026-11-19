import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { AuditClassificationError, currentMutationScope, describeChange, NoMutationScopeError, runMutation, withAudit } from "./audit.ts";

const ID = "u1";

describe("describeChange", () => {
  it("keeps before/after of changed non-PII fields only", () => {
    const out = describeChange({
      action: "admin_user.update",
      entityType: "admin_user",
      entityId: ID,
      fields: { role: "value", disabled: "value", note: "value" },
      before: { role: "staff", disabled: false, note: "x" },
      after: { role: "owner", disabled: false, note: "x" },
    });
    expect(out).toEqual({ changes: { role: { before: "staff", after: "owner" } }, piiRefs: [] });
  });

  it("records PII fields as references, never their values", () => {
    const out = describeChange({
      action: "admin_user.update",
      entityType: "admin_user",
      entityId: ID,
      fields: { email: "pii", display_name: "pii", phone: "pii" },
      before: { email: "old@example.test", display_name: "Budi", phone: null },
      after: { email: "new@example.test", display_name: null, phone: "+6281234567890" },
    });
    expect(out.changes).toEqual({});
    expect(out.piiRefs).toEqual(["admin_user:u1.email changed", "admin_user:u1.display_name cleared", "admin_user:u1.phone set"]);
    const serialized = JSON.stringify(out);
    for (const pii of ["old@example.test", "new@example.test", "Budi", "+6281234567890", "6281234567890"]) {
      expect(serialized).not.toContain(pii);
    }
  });

  it("records secrets as set / unset only", () => {
    const out = describeChange({
      action: "smtp.update",
      entityType: "smtp",
      entityId: "s1",
      fields: { password: "secret", host: "value" },
      before: { password: "old-secret", host: "a" },
      after: { password: "new-secret-value", host: "a" },
    });
    expect(out).toEqual({ changes: { password: { set: true } }, piiRefs: [] });
    expect(JSON.stringify(out)).not.toContain("secret-value");
    expect(
      describeChange({ action: "smtp.update", entityType: "smtp", entityId: "s1", fields: { password: "secret" }, before: { password: "x" }, after: { password: "" } })
        .changes,
    ).toEqual({ password: { set: false } });
  });

  it("describes creates (after only) and deletes (before only)", () => {
    const fields = { role: "value", email: "pii" } as const;
    const created = describeChange({ action: "admin_user.create", entityType: "admin_user", entityId: ID, fields, after: { role: "staff", email: "a@example.test" } });
    expect(created).toEqual({ changes: { role: { after: "staff" } }, piiRefs: ["admin_user:u1.email set"] });
    const deleted = describeChange({ action: "admin_user.delete", entityType: "admin_user", entityId: ID, fields, before: { role: "staff", email: "a@example.test" } });
    expect(deleted).toEqual({ changes: { role: { before: "staff" } }, piiRefs: ["admin_user:u1.email cleared"] });
  });

  it("serializes dates as ISO strings and compares by value", () => {
    const at = new Date("2026-11-18T03:00:00.000Z");
    const out = describeChange({
      action: "program.update",
      entityType: "program",
      entityId: "p1",
      fields: { sales_end_at: "value", grace_days: "value" },
      before: { sales_end_at: at, grace_days: 30 },
      after: { sales_end_at: new Date(at.getTime()), grace_days: 31 },
    });
    expect(out.changes).toEqual({ grace_days: { before: 30, after: 31 } });
    const moved = describeChange({ action: "program.update", entityType: "program", entityId: "p1", fields: { sales_end_at: "value" }, before: { sales_end_at: at }, after: { sales_end_at: new Date(0) } });
    expect(moved.changes).toEqual({ sales_end_at: { before: "2026-11-18T03:00:00.000Z", after: "1970-01-01T00:00:00.000Z" } });
  });

  it("refuses unclassified fields, bad names and facts that shadow a field", () => {
    expect(() => describeChange({ action: "admin_user.update", entityType: "admin_user", entityId: ID, fields: { role: "value" }, after: { role: "owner", email: "x@example.test" } })).toThrow(
      AuditClassificationError,
    );
    expect(() => describeChange({ action: "Admin User", entityType: "admin_user", entityId: ID })).toThrow(AuditClassificationError);
    expect(() => describeChange({ action: "admin_user.update", entityType: "admin-user", entityId: ID })).toThrow(AuditClassificationError);
    expect(() => describeChange({ action: "a.b", entityType: "e", entityId: null, fields: { role: "value" }, facts: { role: "x" } })).toThrow(AuditClassificationError);
  });

  it("adds non-PII facts as they are", () => {
    expect(describeChange({ action: "admin_auth.sign_in", entityType: "admin_user", entityId: ID, facts: { mfa_method: "totp", attempts: 1 } })).toEqual({
      changes: { mfa_method: "totp", attempts: 1 },
      piiRefs: [],
    });
  });
});

describe("withAudit outside a mutation scope", () => {
  it("refuses before touching the database (no mutation on GET)", async () => {
    const sql = {
      begin: () => {
        throw new Error("must not open a transaction");
      },
    } as unknown as postgres.Sql;
    await expect(withAudit(sql, () => Promise.resolve(1))).rejects.toThrow(NoMutationScopeError);
  });

  it("sees the scope only inside runMutation", async () => {
    expect(currentMutationScope()).toBeUndefined();
    const scope = { actor: { kind: "system" as const }, requestId: "r1", ip: null };
    await runMutation(scope, async () => {
      await Promise.resolve();
      expect(currentMutationScope()).toBe(scope);
    });
    expect(currentMutationScope()).toBeUndefined();
  });
});
