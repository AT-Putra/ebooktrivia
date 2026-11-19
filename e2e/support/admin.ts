// Admin console e2e environment: a throwaway migrated database with an admin_rw LOGIN role
// (@ebooktrivia/test-support/database), the production build of apps/admin started with
// `next start` on its own port and configuration, the first Owner created through the real VM CLI.
// TOTP codes come from @ebooktrivia/test-support/totp. `next start` serves plain http on
// 127.0.0.1, so the app gets ADMIN_ALLOW_INSECURE_LOOPBACK=1 (never set on a server).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import postgres from "postgres";

export { freshTotp, wrongTotp } from "@ebooktrivia/test-support/totp";

export const ADMIN_AUTH_PORT = 3202;
export const ADMIN_AUTH_URL = `http://127.0.0.1:${String(ADMIN_AUTH_PORT)}`;
/** Another origin (same host, other port) for the cross-origin requests. */
export const OTHER_ORIGIN = "http://127.0.0.1:3299";

const adminDir = fileURLToPath(new URL("../../apps/admin/", import.meta.url));

export interface AdminEnv {
  readonly sql: postgres.Sql;
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

export async function startAdminEnv(): Promise<AdminEnv> {
  const db = await createTestDatabase("ebt_e2e", ["admin_rw"]);
  const env = {
    NODE_ENV: "production",
    ADMIN_ORIGIN: ADMIN_AUTH_URL,
    ADMIN_ALLOW_INSECURE_LOOPBACK: "1",
    ADMIN_AUTH_SECRETS: `1:${randomBytes(32).toString("hex")}`,
    DATABASE_URL_ADMIN: db.logins.admin_rw ?? "",
  };
  const sql = postgres(db.url, { max: 2, onnotice: () => undefined });
  const nextBin = createRequire(`${adminDir}package.json`).resolve("next/dist/bin/next");
  const child: ChildProcess = spawn(process.execPath, [nextBin, "start", "-p", String(ADMIN_AUTH_PORT)], {
    cwd: adminDir,
    env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", ...env },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${ADMIN_AUTH_URL}/login`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("admin did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    sql,
    env,
    async stop() {
      child.kill();
      await sql.end({ timeout: 5 });
      await db.drop();
    },
  };
}

/** Runs the admin CLI (apps/admin/src/cli/admin.ts) with `stdin` as the password input. */
export function runAdminCli(env: Record<string, string>, args: readonly string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli/admin.ts", ...args], {
      cwd: adminDir,
      env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", ...env },
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
