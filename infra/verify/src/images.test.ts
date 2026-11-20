// The app images that run TypeScript sources directly (worker, admin-cli; infra/images/app/
// Containerfile) copy the workspace packages they need by hand. Code review US-017 H1/H2: a new
// workspace import (worker -> @ebooktrivia/crypto, admin CLI -> core / crypto) made both images die
// at load with ERR_MODULE_NOT_FOUND. For every such build stage, every workspace package the app
// depends on at runtime (dependencies, transitively) must be copied into the image.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CONTAINERFILE = readFileSync(join(REPO, "infra/images/app/Containerfile"), "utf8");

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as Manifest;

/** Workspace package name -> its directory under packages/. */
const PACKAGES = new Map(
  readdirSync(join(REPO, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [manifest(`packages/${d.name}`).name, d.name] as const),
);

/** The packages/ directories `dir` needs at runtime: workspace dependencies, transitively. */
export function runtimeWorkspacePackages(dir: string, seen = new Set<string>()): Set<string> {
  for (const [name, range] of Object.entries(manifest(dir).dependencies ?? {})) {
    if (!range.startsWith("workspace:")) continue;
    const pkg = PACKAGES.get(name);
    if (pkg === undefined) throw new Error(`${dir} depends on ${name}, which is not under packages/`);
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    runtimeWorkspacePackages(`packages/${pkg}`, seen);
  }
  return seen;
}

/** Build stages that copy an app's sources by hand: stage -> { app dir, copied packages }. */
function manualStages(): Map<string, { app: string; copied: Set<string> }> {
  const stages = new Map<string, { app: string; copied: Set<string> }>();
  const parts = CONTAINERFILE.split(/^FROM /m).slice(1);
  for (const part of parts) {
    const stage = /^\S+ AS (\S+)/.exec(part)?.[1];
    const loop = /for p in ([a-z0-9 -]+); do cp -a "packages\/\$p"/.exec(part);
    if (stage === undefined || loop === null) continue;
    const app = /cp -a (?:apps\/([a-z-]+)(?:\/package\.json)?)\b/.exec(part)?.[1];
    if (app === undefined) throw new Error(`stage ${stage} copies packages but no app`);
    stages.set(stage, { app: `apps/${app}`, copied: new Set((loop[1] ?? "").trim().split(/\s+/)) });
  }
  return stages;
}

describe("app images (infra/images/app/Containerfile)", () => {
  it("finds the hand-copied stages: worker and admin-cli", () => {
    expect([...manualStages().keys()].sort()).toEqual(["build-admin-cli", "build-worker"]);
  });

  it.each([...manualStages().entries()])("%s copies every workspace package its app needs at runtime", (_stage, { app, copied }) => {
    const needed = [...runtimeWorkspacePackages(app)].sort();
    expect(needed.filter((p) => !copied.has(p)), `${app} needs ${needed.join(", ")}`).toEqual([]);
  });

  it("computes transitive workspace dependencies", () => {
    // crypto -> core: a package needed only through another one still counts.
    expect([...runtimeWorkspacePackages("packages/crypto")]).toEqual(["core"]);
  });
});
