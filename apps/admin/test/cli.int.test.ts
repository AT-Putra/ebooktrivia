// The VM CLI as the operator runs it (a real `node src/cli/admin.ts` process, password on stdin),
// against the migrated database with the admin_rw login: Owner bootstrap and Owner recovery, both
// audited as actor "cli". Recovery always sets a new password (security review US-016 SM1), and
// concurrent bootstraps create one Owner (SL2).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";
import { bootstrapOwner } from "../src/lib/admin-users.ts";
import { runMutation } from "../src/lib/audit.ts";
import { signInWithPassword } from "../src/lib/auth/service.ts";
import { loadAdminSession } from "../src/lib/auth/session.ts";
import { auditRows, CookieJar, enroll, freshIp, newRuntime, password, root, suffix, system, TEST_CONFIG } from "./support.ts";

const CLI = fileURLToPath(new URL("../src/cli/admin.ts", import.meta.url));
const rt = newRuntime();

function runCli(args: readonly string[], stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env["PATH"] ?? "",
        SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
        NODE_ENV: "test",
        ADMIN_ORIGIN: TEST_CONFIG.origin,
        ADMIN_ALLOW_INSECURE_LOOPBACK: "1",
        ADMIN_AUTH_SECRETS: TEST_CONFIG.authSecrets.map((s) => `${String(s.version)}:${s.value}`).join(","),
        DATABASE_URL_ADMIN: TEST_CONFIG.databaseUrl,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

describe("admin CLI", () => {
  it("bootstraps the first Owner once, audited as the CLI; the password never appears in output or audit", async () => {
    // A database without an Owner (other test files create some on the shared database).
    await root`UPDATE admin_profiles SET role = 'staff' WHERE role = 'owner'`;
    const email = `owner-${suffix()}@example.test`;
    const pw = password();
    const first = await runCli(["bootstrap-owner", "--email", email, "--name", "Pemilik"], `${pw}\n`);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const userId = /owner created: (\S+)/.exec(first.stdout)?.[1] ?? "";
    expect(userId).not.toBe("");
    const [profile] = await root<{ role: string }[]>`SELECT role FROM admin_profiles WHERE auth_user_id = ${userId}`;
    expect(profile?.role).toBe("owner");
    const [audit] = await auditRows(userId, "cli.bootstrap_owner");
    expect(audit).toMatchObject({ actor_kind: "cli", actor_admin_user_id: null, changes: { role: { after: "owner" }, password: { set: true } } });
    expect(audit?.request_id).toMatch(/^cli-[0-9a-f]{16}$/);
    expect(JSON.stringify(audit)).not.toContain(pw);
    expect(first.stdout + first.stderr).not.toContain(pw);

    const second = await runCli(["bootstrap-owner", "--email", `other-${suffix()}@example.test`, "--name", "Lain"], `${password()}\n`);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("an Owner already exists");
  });

  it("creates exactly one Owner when bootstraps run concurrently", async () => {
    await root`UPDATE admin_profiles SET role = 'staff' WHERE role = 'owner'`;
    const cli = { actor: { kind: "cli" as const }, requestId: "test", ip: null };
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runMutation(cli, () => bootstrapOwner(rt.sql, { email: `race-${String(i)}-${suffix()}@example.test`, displayName: "Race", password: password() })),
      ),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "owner_exists")).toHaveLength(5);
    const [owners] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_profiles WHERE role = 'owner'`;
    expect(owners?.n).toBe(1);
  });

  it("recovers a locked-out admin: TOTP off, codes and sessions gone, lockout cleared, new password; audited", async () => {
    // An enrolled admin with an active session, locked out at the password step.
    const enrolled = await enroll(rt);
    const { email, password: pw, jar } = enrolled;
    const created = { userId: enrolled.userId };
    const ip = freshIp();
    expect((await loadAdminSession(rt, jar.request(ip).headers)).status).toBe("active");
    for (let i = 0; i < 5; i++) await system(() => signInWithPassword(rt, { email, password: "wrong-password-xyz" }, new CookieJar().request(freshIp())));

    const fresh = password();
    const res = await runCli(["recover", "--email", email.toUpperCase()], `${fresh}\n`);
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`recovered ${created.userId}`);

    expect(await loadAdminSession(rt, jar.request(ip).headers)).toEqual({ status: "anonymous" });
    expect(await root`SELECT 1 FROM admin_auth.recovery_code WHERE user_id = ${created.userId}`).toHaveLength(0);
    expect(await root`SELECT 1 FROM admin_auth."twoFactor" WHERE "userId" = ${created.userId}`).toHaveLength(0);
    const [audit] = await auditRows(created.userId, "cli.recover_admin");
    expect(audit).toMatchObject({
      actor_kind: "cli",
      changes: { two_factor_enabled: { before: true, after: false }, password: { set: true }, recovery_codes_removed: 10, sessions_revoked: 1, authenticators_removed: 1 },
    });

    // The old password no longer works (whoever knew it cannot enroll an authenticator of their
    // own), the new one does (lockout cleared) and forces enrollment.
    const old = await system(() => signInWithPassword(rt, { email, password: pw }, new CookieJar().request(freshIp())));
    expect(old.outcome.kind).toBe("invalid");
    const now = await system(() => signInWithPassword(rt, { email, password: fresh }, new CookieJar().request(freshIp())));
    expect(now.outcome.kind).toBe("enroll");
  });

  it("refuses unknown accounts, bad usage and a login outside admin_rw", async () => {
    const missing = await runCli(["recover", "--email", `nobody-${suffix()}@example.test`], `${password()}\n`);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no admin with that e-mail");
    const noPassword = await runCli(["recover", "--email", `nobody-${suffix()}@example.test`], "\n");
    expect(noPassword.code).toBe(2);
    expect(noPassword.stderr).toContain("invalid password");
    const oldFlag = await runCli(["recover", "--email", "x@example.test", "--reset-password"], "");
    expect(oldFlag.code).toBe(1);
    const usage = await runCli(["delete-everything", "--email", "x@example.test"], "");
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain("usage:");
    const superuser = await runCli(["recover", "--email", "x@example.test"], "", { DATABASE_URL_ADMIN: inject("dbUrl") });
    expect(superuser.code).toBe(1);
    expect(superuser.stderr).toContain("admin_rw");
    const noSecret = await runCli(["recover", "--email", "x@example.test"], "", { ADMIN_AUTH_SECRETS: "" });
    expect(noSecret.code).toBe(1);
    expect(noSecret.stderr).toContain("ADMIN_AUTH_SECRETS");
  });
});
