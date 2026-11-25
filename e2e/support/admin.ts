// Admin console e2e environment: a throwaway migrated database with an admin_rw LOGIN role
// (@ebooktrivia/test-support/database), the production build of apps/admin started with
// `next start` on its own port and configuration, the first Owner created through the real VM CLI.
// TOTP codes come from @ebooktrivia/test-support/totp. `next start` serves plain http on
// 127.0.0.1, so the app gets ADMIN_ALLOW_INSECURE_LOOPBACK=1 (never set on a server).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import postgres from "postgres";
import type { Locator, Page } from "@playwright/test";

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

/**
 * A database and an admin server of its own. `port` / `extraEnv` let a second spec run its own
 * server next to admin-auth.spec.ts (the build's allowedOrigins name port 3202, but Next.js also
 * accepts an Origin equal to the request's own host, and the app's exact check reads ADMIN_ORIGIN
 * at runtime).
 */
export async function startAdminEnv(options: { readonly port?: number; readonly extraEnv?: Readonly<Record<string, string>> } = {}): Promise<AdminEnv> {
  const port = options.port ?? ADMIN_AUTH_PORT;
  const origin = `http://127.0.0.1:${String(port)}`;
  const db = await createTestDatabase("ebt_e2e", ["admin_rw"]);
  const env = {
    NODE_ENV: "production",
    ADMIN_ORIGIN: origin,
    ADMIN_ALLOW_INSECURE_LOOPBACK: "1",
    ADMIN_AUTH_SECRETS: `1:${randomBytes(32).toString("hex")}`,
    DATABASE_URL_ADMIN: db.logins.admin_rw ?? "",
    // admin.env holds the messaging public key in production: every password set seals its breached-password check
    // to it (US-031; no worker runs here, so the jobs are never looked up).
    SECRETS_MESSAGING_PUBLIC_KEY: generateScopeKeyPair().publicKey.toString("base64url"),
    ...options.extraEnv,
  };
  const sql = postgres(db.url, { max: 2, onnotice: () => undefined });
  const nextBin = createRequire(`${adminDir}package.json`).resolve("next/dist/bin/next");
  const child: ChildProcess = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: adminDir,
    env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", ...env },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${origin}/login`);
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

/**
 * The console menu, ready to read (2026-11-25: the menu is in collapsible groups, and on a phone behind a "Menu" button): opens the phone
 * menu when it is the one shown, then the group `group` (dashboard, orders, reports, program, messaging, payments, system) when it is
 * closed. Returns the menu that is on screen.
 */
/** Every console-menu link to `href`, open or closed group, phone or sidebar menu: "count 0" then means the server never rendered it. */
export function consoleNavLinks(page: Page, href: string): Locator {
  return page.locator(`nav[aria-label="Console"] a[href="${href}"]`);
}

export async function openConsoleNav(page: Page, group?: string): Promise<Locator> {
  const menu = page.getByTestId("nav-menu");
  if ((await menu.isVisible()) && (await menu.getAttribute("open")) === null) await menu.locator("summary").first().click();
  const nav = page.getByRole("navigation", { name: "Console" }).first();
  if (group !== undefined) {
    const details = nav.getByTestId(`nav-group-${group}`);
    if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
  }
  return nav;
}
