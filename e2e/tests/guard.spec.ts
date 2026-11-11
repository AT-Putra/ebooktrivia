import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ADMIN_GUARDED_URL, PUBLIC_GUARDED_URL, ROUTES } from "../routes.ts";

/**
 * The same production builds, started WITHOUT ENABLE_MOCKUPS, must answer 404 on every mockup route.
 * The builds are produced by playwright.config.ts (webServer) with ENABLE_MOCKUPS=1; the guard is
 * evaluated per request, so removing the variable at start-up is what disables the routes.
 */
const children: ChildProcess[] = [];

async function startGuarded(appDir: string, port: number): Promise<void> {
  const cwd = fileURLToPath(new URL(`../../apps/${appDir}/`, import.meta.url));
  const nextBin = createRequire(`${cwd}package.json`).resolve("next/dist/bin/next");
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env["ENABLE_MOCKUPS"];
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], { cwd, env, stdio: "ignore" });
  children.push(child);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`guarded ${appDir} did not start on ${port}`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await Promise.all([startGuarded("public", 3101), startGuarded("admin", 3201)]);
});

test.afterAll(() => {
  for (const child of children) child.kill();
});

for (const route of ROUTES) {
  test(`mockup route ${route.slug} (${route.path}) is 404 without ENABLE_MOCKUPS=1`, async ({ request }) => {
    const base = route.app === "public" ? PUBLIC_GUARDED_URL : ADMIN_GUARDED_URL;
    const response = await request.get(base + route.path);
    expect(response.status()).toBe(404);
  });
}
