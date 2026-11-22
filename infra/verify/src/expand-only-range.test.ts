// The git side of the deploy job's check (US-015 review): infra/verify/local/expand-only.sh against a real history of several commits, where the base is
// the release running on the VM and the new release is many commits ahead. A throwaway repository holds the scripts and four migrations.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};
const ready = spawnSync("bash", ["-c", "true"]).status === 0 && spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!ready)("expand-only.sh over a range of commits", () => {
  let dir: string;
  const shas: Record<string, string> = {};
  const git = (...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "core.autocrlf=false", ...args], dir);
  const commit = (name: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, "packages/db/migrations", file), text);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    shas[name] = git("rev-parse", "HEAD").out.trim();
  };
  const expandOnly = (...args: string[]) => run("bash", ["infra/verify/local/expand-only.sh", ...args], dir);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ebt-expand-range-"));
    mkdirSync(join(dir, "infra/verify/local"), { recursive: true });
    mkdirSync(join(dir, "infra/verify/src"), { recursive: true });
    mkdirSync(join(dir, "packages/db/migrations"), { recursive: true });
    copyFileSync(join(REPO, "infra/verify/local/expand-only.sh"), join(dir, "infra/verify/local/expand-only.sh"));
    copyFileSync(join(REPO, "infra/verify/src/expand-only-cli.ts"), join(dir, "infra/verify/src/expand-only-cli.ts"));
    copyFileSync(join(REPO, "infra/verify/src/expand-only.ts"), join(dir, "infra/verify/src/expand-only.ts"));
    git("init", "-q");
    commit("A", { "0001_init.sql": 'CREATE TABLE "orders" ("id" uuid PRIMARY KEY, "legacy_code" text);\n' });
    commit("B", { "0002_note.sql": 'ALTER TABLE "orders" ADD COLUMN "note" text;\n' });
    commit("C", { "0003_contract.sql": '-- contract-ok: nothing since release 14 reads legacy_code\nALTER TABLE "orders" DROP COLUMN "legacy_code";\n' });
    commit("D", { "0004_index.sql": 'CREATE INDEX "orders_note" ON "orders" ("note");\n' });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a one-step range that only expands passes in both modes", () => {
    expect(expandOnly(shas.C ?? "").status).toBe(0);
    expect(expandOnly("--refuse-contract-ok", shas.C ?? "").status).toBe(0);
  });

  it("without the flag a contract-ok line covers its file, however far back the base is", () => {
    const run1 = expandOnly(shas.A ?? "");
    expect(run1.status).toBe(0);
    expect(run1.out).toMatch(/marked +packages\/db\/migrations\/0003_contract\.sql/);
  });

  it("with the flag a contract-ok migration anywhere in the range refuses the deploy, and says which", () => {
    for (const base of ["A", "B"]) {
      const result = expandOnly("--refuse-contract-ok", shas[base] ?? "");
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/CONTRACT-OK packages\/db\/migrations\/0003_contract\.sql/);
      expect(result.out).toMatch(/1 refused/);
    }
  });

  it("a range with nothing new has nothing to refuse", () => {
    const result = expandOnly("--refuse-contract-ok", shas.D ?? "");
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/no new migration/);
  });

  it("an applied migration changed since the base refuses, flag or not", () => {
    writeFileSync(join(dir, "packages/db/migrations/0002_note.sql"), 'ALTER TABLE "orders" ADD COLUMN "note" text NOT NULL DEFAULT \'\';\n');
    const result = expandOnly(shas.B ?? "");
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/applied migration was changed or removed/);
    git("checkout", "--", "packages/db/migrations/0002_note.sql");
  });

  it("an older release than the one on the VM (migrations the VM has, removed) refuses", () => {
    expect(expandOnly("--refuse-contract-ok", shas.D ?? "").status).toBe(0);
    git("checkout", "-q", shas.B ?? "", "--", "packages/db/migrations");
    git("rm", "-q", "-f", "packages/db/migrations/0003_contract.sql", "packages/db/migrations/0004_index.sql");
    const result = expandOnly("--refuse-contract-ok", shas.D ?? "");
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/applied migration was changed or removed/);
  });
});
