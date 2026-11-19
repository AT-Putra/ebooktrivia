/**
 * Lighthouse (mobile form factor) against every mockup route, using Playwright's Chromium.
 * Fails (exit 1) when accessibility < 0.95 or CLS >= 0.1.
 *
 * Servers: reuses ones already listening on 3100/3200; otherwise builds (ENABLE_MOCKUPS=1) and starts them.
 * Usage: pnpm --filter @ebooktrivia/e2e lighthouse:mockups
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";
import { ADMIN_URL, PUBLIC_URL, ROUTES, urlFor } from "./routes.ts";

const MIN_A11Y = 0.95;
const MAX_CLS = 0.1;
const DEBUG_PORT = 9300 + (process.pid % 600);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = fileURLToPath(new URL("./lighthouse-results/", import.meta.url));
const started: ChildProcess[] = [];

async function isUp(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(app: "public" | "admin", url: string, port: number): Promise<void> {
  if (await isUp(url)) return;
  const filter = `@ebooktrivia/${app}`;
  console.log(`building and starting ${filter} on ${port} ...`);
  const build = spawnSync(`pnpm --filter ${filter} run build`, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ENABLE_MOCKUPS: "1", ADMIN_ORIGIN: "http://127.0.0.1:3202", ADMIN_ALLOW_INSECURE_LOOPBACK: "1" },
  });
  if (build.status !== 0) throw new Error(`build failed for ${filter}`);
  const appDir = `${repoRoot}apps/${app}/`;
  const nextBin = createRequire(`${appDir}package.json`).resolve("next/dist/bin/next");
  started.push(
    spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
      cwd: appDir,
      stdio: "ignore",
      env: { ...process.env, ENABLE_MOCKUPS: "1" },
    }),
  );
  const deadline = Date.now() + 60_000;
  while (!(await isUp(url))) {
    if (Date.now() > deadline) throw new Error(`${filter} did not start`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

type Lhr = NonNullable<Awaited<ReturnType<typeof lighthouse>>>["lhr"];

interface Row {
  route: string;
  accessibility: number;
  cls: number;
  performance: number;
  pass: boolean;
}

async function main(): Promise<void> {
  await ensureServer("public", PUBLIC_URL, 3100);
  await ensureServer("admin", ADMIN_URL, 3200);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ channel: "chromium", args: [`--remote-debugging-port=${DEBUG_PORT}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] });
  const rows: Row[] = [];
  try {
    // The light admin variant is a toggle, not a URL: Lighthouse audits the default (dark) theme.
    for (const route of ROUTES.filter((r) => r.light !== true)) {
      const url = urlFor(route);
      // Windows can occasionally report NO_FCP for the first loads of a fresh browser: retry before failing.
      let lhr: Lhr | undefined;
      for (let attempt = 1; attempt <= 3 && (lhr === undefined || lhr.runtimeError !== undefined); attempt++) {
        const result = await lighthouse(url, {
          port: DEBUG_PORT,
          output: "json",
          logLevel: "error",
          onlyCategories: ["accessibility", "performance"],
          formFactor: "mobile",
          screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false },
        });
        if (result === undefined) throw new Error(`no Lighthouse result for ${url}`);
        lhr = result.lhr;
        if (lhr.runtimeError !== undefined) console.error(`${url}: attempt ${attempt} ${lhr.runtimeError.code}`);
      }
      if (lhr === undefined) throw new Error(`no Lighthouse result for ${url}`);
      const accessibility = lhr.categories["accessibility"]?.score ?? 0;
      const performance = lhr.categories["performance"]?.score ?? 0;
      const cls = lhr.audits["cumulative-layout-shift"]?.numericValue ?? Number.POSITIVE_INFINITY;
      const pass = accessibility >= MIN_A11Y && cls < MAX_CLS;
      rows.push({ route: route.path, accessibility, cls: Math.round(cls * 10000) / 10000, performance, pass });
      writeFileSync(
        `${outDir}${route.slug}.json`,
        JSON.stringify({ url, formFactor: lhr.configSettings.formFactor, accessibility, performance, cls, pass }, null, 2),
      );
    }
  } finally {
    await browser.close();
    for (const child of started) child.kill();
  }

  console.table(
    rows.map((r) => ({
      route: r.route,
      "a11y (>=0.95)": r.accessibility,
      "CLS (<0.1)": r.cls,
      "perf (info)": r.performance,
      result: r.pass ? "PASS" : "FAIL",
    })),
  );
  if (rows.some((r) => !r.pass)) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  for (const child of started) child.kill();
  process.exit(1);
});
