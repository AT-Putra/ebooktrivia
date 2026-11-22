// The audit middleware writes in the same transaction as the change; PII fields carry references
// only, non-PII fields before/after values; least privilege: the admin app's login is admin_rw only,
// and the public app's role cannot reach admin_auth.
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { inject } from "vitest";
import { createAdminUser, listAdminUsers, setAdminDisabled } from "../src/lib/admin-users.ts";
import { AuditClassificationError, NoMutationScopeError, runMutation, withAudit } from "../src/lib/audit.ts";
import { assertAdminLogin, createAdminDb, LoginRoleError } from "../src/lib/db.ts";
import { auditRows, createTestAdmin, newRuntime, password, root, suffix, system } from "./support.ts";

const rt = newRuntime();
const asAdmin = <T>(userId: string, fn: () => Promise<T>) => runMutation({ actor: { kind: "admin", userId }, requestId: `req-${suffix()}`, ip: "203.0.113.9" }, fn);

const tempSetting = (): string => `test.audit_${suffix()}`;

describe("withAudit", () => {
  it("writes the change and its audit row in one transaction", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const key = tempSetting();
    await asAdmin(owner.userId, () =>
      withAudit(rt.sql, async (tx, audit) => {
        await tx`INSERT INTO app_settings (key, value, updated_by_admin_user_id) VALUES (${key}, '3'::jsonb, ${owner.userId})`;
        audit({ action: "app_setting.create", entityType: "app_setting", entityId: key, fields: { value: "value" }, after: { value: 3 } });
      }),
    );
    const [setting] = await root<{ xmin: string }[]>`SELECT xmin::text FROM app_settings WHERE key = ${key}`;
    const [row] = await root<{ xmin: string; actor_kind: string; actor_admin_user_id: string; changes: unknown; request_id: string; ip: string }[]>`
      SELECT xmin::text, actor_kind, actor_admin_user_id, changes, request_id, host(ip) AS ip FROM audit_log WHERE entity_id = ${key}`;
    expect(row).toMatchObject({ actor_kind: "admin", actor_admin_user_id: owner.userId, changes: { value: { after: 3 } }, ip: "203.0.113.9" });
    expect(row?.request_id).toMatch(/^req-/);
    expect(setting?.xmin).toBe(row?.xmin);
  });

  it("rolls the change back when its audit entry cannot be written", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const key = tempSetting();
    await expect(
      asAdmin(owner.userId, () =>
        withAudit(rt.sql, async (tx, audit) => {
          await tx`INSERT INTO app_settings (key, value) VALUES (${key}, '1'::jsonb)`;
          // An unclassified field: the entry is refused, so is the change.
          audit({ action: "app_setting.create", entityType: "app_setting", entityId: key, fields: {}, after: { value: 1 } });
        }),
      ),
    ).rejects.toThrow(AuditClassificationError);
    expect(await root`SELECT 1 FROM app_settings WHERE key = ${key}`).toHaveLength(0);
  });

  it("rolls the audit entry back when the change fails after it was recorded", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const key = tempSetting();
    await expect(
      asAdmin(owner.userId, () =>
        withAudit(rt.sql, async (tx, audit) => {
          audit({ action: "app_setting.create", entityType: "app_setting", entityId: key, fields: { value: "value" }, after: { value: -1 } });
          await tx`INSERT INTO app_settings (key, value) VALUES (${key}, '1'::jsonb)`;
          await tx`INSERT INTO app_settings (key, value) VALUES (${key}, '2'::jsonb)`;
        }),
      ),
    ).rejects.toThrow(postgres.PostgresError);
    expect(await root`SELECT 1 FROM audit_log WHERE entity_id = ${key}`).toHaveLength(0);
    expect(await root`SELECT 1 FROM app_settings WHERE key = ${key}`).toHaveLength(0);
  });

  it("refuses a mutation that records no audit entry", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const key = tempSetting();
    await expect(
      asAdmin(owner.userId, () =>
        withAudit(rt.sql, async (tx) => {
          await tx`INSERT INTO app_settings (key, value) VALUES (${key}, '1'::jsonb)`;
        }),
      ),
    ).rejects.toThrow(/at least one audit entry/);
    expect(await root`SELECT 1 FROM app_settings WHERE key = ${key}`).toHaveLength(0);
  });

  it("refuses outside a mutation scope (page renders and GET handlers have none)", async () => {
    await expect(withAudit(rt.sql, () => Promise.resolve())).rejects.toThrow(NoMutationScopeError);
  });
});

describe("admin user changes in the audit log", () => {
  it("creating an admin stores references for e-mail and name, the role as a value, never the PII", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const email = `staff-${suffix()}@example.test`;
    const name = `Siti ${suffix()}`;
    const pw = password();
    const res = await asAdmin(owner.userId, () => createAdminUser(rt, { email, displayName: name, password: pw }, "staff", "admin_user.create"));
    if (res.kind !== "created") throw new Error(res.kind);
    const [row] = await auditRows(res.userId, "admin_user.create");
    expect(row).toMatchObject({ actor_kind: "admin", actor_admin_user_id: owner.userId });
    expect(row?.changes).toEqual({ role: { after: "staff" }, disabled: { after: false }, password: { set: true }, enroll_within_hours: 72 });
    expect(row?.pii_refs).toEqual([`admin_user:${res.userId}.email set`, `admin_user:${res.userId}.display_name set`]);
    const [raw] = await root<{ t: string }[]>`SELECT row_to_json(a)::text AS t FROM audit_log a WHERE id = ${row?.id ?? 0}`;
    for (const secret of [email, name, pw, email.split("@")[0] ?? email]) expect(raw?.t).not.toContain(secret);
    const listed = await listAdminUsers(rt.sql);
    expect(listed.find((u) => u.userId === res.userId)).toMatchObject({ email, displayName: name, role: "staff", disabled: false, twoFactorEnabled: false });
  });

  it("refuses a duplicate e-mail and invalid input without writing anything", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const existing = await createTestAdmin(rt);
    const count = async () => (await root<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`)[0]?.n;
    const before = await count();
    expect(await asAdmin(owner.userId, () => createAdminUser(rt, { email: existing.email.toUpperCase(), displayName: "X", password: password() }, "staff", "admin_user.create"))).toEqual({
      kind: "email_taken",
    });
    expect(await asAdmin(owner.userId, () => createAdminUser(rt, { email: "no-at-sign", displayName: "X", password: password() }, "staff", "admin_user.create"))).toEqual({
      kind: "invalid",
      field: "email",
    });
    expect(await asAdmin(owner.userId, () => createAdminUser(rt, { email: `a-${suffix()}@example.test`, displayName: "X", password: "short" }, "staff", "admin_user.create"))).toEqual({
      kind: "invalid",
      field: "password",
    });
    expect(await count()).toBe(before);
  });

  it("disabling stores before/after of the non-PII flag; the Owner cannot disable themself", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const staff = await createTestAdmin(rt);
    expect(await asAdmin(owner.userId, () => setAdminDisabled(rt.sql, owner.userId, owner.userId, true))).toEqual({ kind: "self" });
    expect(await asAdmin(owner.userId, () => setAdminDisabled(rt.sql, owner.userId, staff.userId, true))).toEqual({ kind: "updated" });
    expect(await asAdmin(owner.userId, () => setAdminDisabled(rt.sql, owner.userId, staff.userId, false))).toEqual({ kind: "updated" });
    const rows = await auditRows(staff.userId);
    expect(rows.filter((r) => r.action.startsWith("admin_user.")).map((r) => [r.action, r.changes])).toEqual([
      ["admin_user.create", { role: { after: "staff" }, disabled: { after: false }, password: { set: true }, enroll_within_hours: 72 }],
      ["admin_user.disable", { disabled: { before: false, after: true }, sessions_revoked: 0 }],
      ["admin_user.enable", { disabled: { before: true, after: false }, sessions_revoked: 0 }],
    ]);
  });
});

describe("least privilege", () => {
  it("refuses a database login that is not in admin_rw only (a superuser here)", async () => {
    const { sql, close } = createAdminDb(inject("dbUrl"), 1);
    try {
      await expect(assertAdminLogin(sql)).rejects.toThrow(LoginRoleError);
    } finally {
      await close();
    }
    await expect(assertAdminLogin(rt.sql)).resolves.toBeUndefined();
  });

  it("the public app's role cannot read admin_auth or the audit log", async () => {
    const pub = postgres(inject("publicDbUrl"), { max: 1, onnotice: () => undefined });
    try {
      for (const table of ["admin_auth.recovery_code", "admin_auth.session_state", "admin_auth.login_throttle", "admin_auth.totp_used", 'admin_auth."user"', "public.audit_log", "public.admin_profiles"]) {
        const error = await pub.unsafe(`SELECT 1 FROM ${table} LIMIT 1`).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, table).toBeInstanceOf(postgres.PostgresError);
        expect((error as postgres.PostgresError).code, table).toBe("42501");
      }
    } finally {
      await pub.end({ timeout: 5 });
    }
  });

  it("the admin role cannot rewrite or delete audit entries", async () => {
    await system(() => withAudit(rt.sql, async (_tx, audit) => {
      audit({ action: "test.append_only", entityType: "test", entityId: null });
      return Promise.resolve();
    }));
    const error = await rt.sql`UPDATE audit_log SET action = 'x.y' WHERE action = 'test.append_only'`.then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as postgres.PostgresError).code).toBe("42501");
  });
});
