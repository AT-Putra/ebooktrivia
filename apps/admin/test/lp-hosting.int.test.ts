// US-023 (M6e LP ZIP hosting) against a real database, as the admin_rw login, with ADMIN_LP_DIR and
// ADMIN_DATA_DIR in temporary directories:
//   - criterion 2: a valid ZIP is extracted to versions/<lpId>/<n> (the SDK tag injected), the page's
//     current version, and every registered domain's hosts/<host>/current link points at it; a new
//     version and a rollback switch the link; the served set is public.lp_served_hosts();
//   - criterion 3: a zip bomb, traversal, a symlink and a bad extension are refused, audited, and leave
//     nothing behind (no version, no staging directory, no stored ZIP, no uploads row);
//   - retention, domain removal and deactivation unlink a host; foreign entries are left alone.
// On Windows the host link is a junction (lp-hosting.ts); the atomic rename-over of a symlink is a
// Linux-only property, checked by infra/verify/local/lp-headers.sh in a real Caddy container.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeZip } from "../../../packages/uploads/test/zip-fixture.ts";
import { lpZipChunk, lpZipComplete, lpZipInit } from "../src/lib/next/lp-zip-route.ts";
import type { RouteContext } from "../src/lib/next/route.ts";
import type { SettingsConfig } from "../src/lib/settings/env.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { registerDomain, removeDomain, snippet, updateLandingPageSettings } from "../src/lib/settings/landing-pages.ts";
import { writeChunk } from "../src/lib/settings/uploads.ts";
import { activateLpVersion, completeLpZipUpload, initLpZipUpload, LP_VERSION_RETENTION, LpZipRefused, publishLpZip, purgeOldVersions, RELINK_ALERT_AFTER, stopLpHosting, sweepLpFiles, syncLpHosts, syncLpHostsQuietly } from "../src/lib/settings/lp-hosting.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

let lpDir = "";
let dataDir = "";
let settings: SettingsConfig;
let rt: ReturnType<typeof newRuntime>;
let ownerId = "";

beforeAll(async () => {
  lpDir = await mkdtemp(join(tmpdir(), "ebt-lp-"));
  dataDir = await mkdtemp(join(tmpdir(), "ebt-lp-data-"));
  settings = { domain: "example.test", dataDir, lpDir, pdfMaxBytes: 1024 * 1024, uploadMaxOpenSessions: 3, uploadMaxStagedBytes: 1024 * 1024 * 1024, sealer: null };
  rt = newRuntime(undefined, settings);
  ownerId = (await createTestAdmin(rt, "owner")).userId;
});
afterAll(async () => {
  await rm(lpDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);

async function newPage(): Promise<{ id: string; lpKey: string; programId: string }> {
  const [product] = await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`;
  const [program] = await root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${`prog-${suffix()}`}, 'Program', 'draft', now(), now() + interval '30 days', 30) RETURNING id`;
  const lpKey = `lp_${suffix()}${suffix()}`;
  const [lp] = await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${lpKey}, 'LP', ${program?.id ?? ""}) RETURNING id`;
  return { id: lp?.id ?? "", lpKey, programId: program?.id ?? "" };
}

const site = (label: string): Buffer =>
  makeZip([
    { name: "index.html", data: Buffer.from(`<!doctype html><html><head><title>${label}</title></head><body>${label}</body></html>`) },
    { name: "css/site.css", data: Buffer.from("body{margin:0}") },
  ]);
const publish = (lpId: string, zip: Buffer) => as(() => publishLpZip(rt.sql, settings, ownerId, lpId, { bytes: zip, filename: "site.zip" }));
const served = (host: string) => readFile(join(lpDir, "hosts", host, "current", "index.html"), "utf8");
const exists = (path: string) => lstat(path).then(() => true, () => false);
const auditActions = async (lpId: string) => (await root<{ action: string }[]>`SELECT action FROM audit_log WHERE entity_id = ${lpId} ORDER BY id`).map((r) => r.action);

describe("publishing a landing-page ZIP (criterion 2)", () => {
  it("extracts it as version 1 with the SDK tag, makes it live, and links every registered domain to it", async () => {
    const page = await newPage();
    const host = `shop-${suffix()}.example.com`;
    await as(() => registerDomain(rt.sql, page.id, host, "example.test"));
    const result = await publish(page.id, site("v1"));
    expect(result).toEqual({ version: 1, fileCount: 2, uncompressedBytes: expect.any(Number) as number, skipped: 0, hostsSynced: true });
    const html = await readFile(join(lpDir, "versions", page.id, "1", "index.html"), "utf8");
    expect(html).toBe(`<!doctype html><html><head><title>v1</title>${snippet("example.test", page.lpKey)}</head><body>v1</body></html>`);
    expect(await served(host)).toBe(html);
    expect((await lstat(join(lpDir, "hosts", host, "current"))).isSymbolicLink()).toBe(true);
    const [lp] = await root<{ hosting: string; version: number }[]>`
      SELECT lp.hosting, v.version FROM landing_pages lp JOIN lp_versions v ON v.id = lp.current_version_id WHERE lp.id = ${page.id}`;
    expect(lp).toEqual({ hosting: "zip", version: 1 });
    const [upload] = await root<{ kind: string; storage_path: string; size_bytes: string }[]>`
      SELECT u.kind, u.storage_path, u.size_bytes::text FROM uploads u JOIN lp_versions v ON v.upload_id = u.id WHERE v.landing_page_id = ${page.id}`;
    expect(upload?.kind).toBe("lp_zip");
    expect((await readFile(join(dataDir, upload?.storage_path ?? ""))).equals(site("v1"))).toBe(true);
    expect((await root<{ host: string }[]>`SELECT host FROM lp_served_hosts() WHERE landing_page_id = ${page.id}`).map((r) => r.host)).toEqual([host]);
    expect(await auditActions(page.id)).toEqual(["lp_version.publish"]);
    expect(await readdir(join(lpDir, ".staging"))).toEqual([]);
  });

  it("switches the domains to a new version, and back on rollback, keeping both", async () => {
    const page = await newPage();
    const host = `promo-${suffix()}.example.com`;
    await as(() => registerDomain(rt.sql, page.id, host, "example.test"));
    await publish(page.id, site("first"));
    await publish(page.id, site("second"));
    expect(await served(host)).toContain("<body>second</body>");
    const [v1] = await root<{ id: string }[]>`SELECT id FROM lp_versions WHERE landing_page_id = ${page.id} AND version = 1`;
    expect(await as(() => activateLpVersion(rt.sql, settings, page.id, v1?.id ?? ""))).toBe(1);
    expect(await served(host)).toContain("<body>first</body>");
    expect(await exists(join(lpDir, "versions", page.id, "2", "index.html"))).toBe(true);
    expect(await auditActions(page.id)).toEqual(["lp_version.publish", "lp_version.publish", "lp_version.activate"]);
    // Another page's version is not this page's to activate (and the database refuses it too, ET160).
    const other = await newPage();
    await expect(as(() => activateLpVersion(rt.sql, settings, other.id, v1?.id ?? ""))).rejects.toThrow(InvalidInput);
  });

  it(`keeps the last ${String(LP_VERSION_RETENTION)} versions and removes older ones with their files`, async () => {
    const page = await newPage();
    for (let i = 1; i <= LP_VERSION_RETENTION + 1; i++) await publish(page.id, site(`v${String(i)}`));
    const kept = (await root<{ version: number }[]>`SELECT version FROM lp_versions WHERE landing_page_id = ${page.id} ORDER BY version`).map((r) => r.version);
    expect(kept).toEqual([2, 3, 4, 5, 6]);
    expect((await readdir(join(lpDir, "versions", page.id))).sort()).toEqual(["2", "3", "4", "5", "6"]);
    const zips = await root<{ storage_path: string }[]>`SELECT u.storage_path FROM uploads u JOIN lp_versions v ON v.upload_id = u.id WHERE v.landing_page_id = ${page.id}`;
    expect(zips).toHaveLength(5);
    expect((await auditActions(page.id)).filter((a) => a === "lp_version.publish")).toHaveLength(6);
    expect(await root`SELECT 1 FROM audit_log WHERE action = 'lp_version.purge' AND changes->>'landing_page_id' = ${page.id}`).toHaveLength(1);
  });
});

describe("refused ZIPs leave nothing behind (criterion 3)", () => {
  const unixLink = { versionMadeBy: (3 << 8) | 20, externalAttributes: (0o120777 << 16) >>> 0 };
  const index = { name: "index.html", data: Buffer.from("<html><head></head></html>") };
  const cases: [string, Buffer, string][] = [
    ["a zip bomb", makeZip([index, { name: "bomb.js", data: Buffer.alloc(40 * 1024 * 1024), declaredSize: 1, crc: 0 }]), "too_large_uncompressed"],
    ["traversal", makeZip([index, { name: "../../hosts/evil.example/current/index.html", data: Buffer.from("x") }]), "invalid_zip"],
    ["a symlink", makeZip([index, { name: "link.html", data: Buffer.from("/etc/passwd"), method: 0, ...unixLink }]), "symlink"],
    ["a bad extension", makeZip([index, { name: "shell.php", data: Buffer.from("<?php system($_GET[1]);") }]), "extension_not_allowed"],
  ];
  for (const [title, zip, code] of cases) {
    it(`refuses ${title}, audits the refusal and writes nothing`, async () => {
      const page = await newPage();
      const before = { zips: await readdir(join(dataDir, "lp-zips")).catch(() => []), uploads: (await root`SELECT 1 FROM uploads WHERE kind = 'lp_zip'`).length };
      const error = await publish(page.id, zip).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LpZipRefused);
      expect((error as LpZipRefused).issues.map((i) => i.code)).toContain(code);
      expect(await exists(join(lpDir, "versions", page.id))).toBe(false);
      expect(await readdir(join(lpDir, ".staging")).catch(() => [])).toEqual([]);
      expect(await readdir(join(dataDir, "lp-zips")).catch(() => [])).toEqual(before.zips);
      expect((await root`SELECT 1 FROM uploads WHERE kind = 'lp_zip'`).length).toBe(before.uploads);
      const [audit] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE entity_id = ${page.id} AND action = 'lp_version.reject'`;
      expect(audit?.changes["code"]).toBe(code);
    });
  }

  it("goes up in chunks through the routes: 422 with the issues, 413 at init over 25 MiB, 409 while another publish runs", async () => {
    const page = await newPage();
    const ctx = { rt, req: { headers: new Headers(), ip: null }, admin: { userId: ownerId, role: "owner", displayName: "Owner" } } as unknown as RouteContext;
    const call = (fn: typeof lpZipInit, path: string, body: Uint8Array | string, headers: Record<string, string> = {}) =>
      as(() => fn(ctx, new Request(`http://127.0.0.1${path}`, { method: "POST", headers, body: new Blob([typeof body === "string" ? body : new Uint8Array(body)]).stream(), duplex: "half" } as RequestInit)));
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    async function upload(zip: Buffer): Promise<string> {
      const init = await call(lpZipInit, "/uploads/lp-zip/init", JSON.stringify({ landingPageId: page.id, filename: "site.zip", size: zip.length, sha256: sha(zip) }), { "content-type": "application/json" });
      expect(init.status).toBe(200);
      const { sessionId, chunkBytes, chunkCount } = (await init.json()) as { sessionId: string; chunkBytes: number; chunkCount: number };
      for (let i = 0; i < chunkCount; i++) {
        const chunk = zip.subarray(i * chunkBytes, (i + 1) * chunkBytes);
        expect((await call(lpZipChunk, `/uploads/lp-zip/chunk?session=${sessionId}&index=${String(i)}`, chunk, { "x-chunk-sha256": sha(chunk) })).status).toBe(200);
      }
      return sessionId;
    }
    const complete = (sessionId: string) => call(lpZipComplete, `/uploads/lp-zip/complete?session=${sessionId}`, "");

    const refused = await complete(await upload(makeZip([index, { name: "a.exe", data: Buffer.from("MZ") }])));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "rejected", issues: [{ code: "extension_not_allowed", entry: "a.exe", message: "the file type .exe is not allowed" }] });
    const big = await call(lpZipInit, "/uploads/lp-zip/init", JSON.stringify({ landingPageId: page.id, filename: "big.zip", size: 25 * 1024 * 1024 + 1, sha256: "0".repeat(64) }));
    expect(big.status).toBe(413);
    expect((await call(lpZipInit, "/uploads/lp-zip/init", JSON.stringify({ landingPageId: page.id, filename: "site.rar", size: 10, sha256: "0".repeat(64) }))).status).toBe(400);

    // Several chunks (a 2.5 MiB stored file); two completions at once: the second is refused before it reads anything.
    const large = makeZip([index, { name: "pad.txt", data: Buffer.alloc(2.5 * 1024 * 1024, 0x61), method: 0 }]);
    const first = await upload(large);
    const second = await upload(site("second"));
    const [a, b] = await Promise.all([complete(first), complete(second)]);
    expect([a.status, b.status]).toEqual([200, 409]);
    expect(await a.json()).toMatchObject({ version: 1, fileCount: 2, skipped: 0, hostsSynced: true });
    const [unclaimed] = await root<{ completing_at: Date | null }[]>`SELECT completing_at FROM upload_sessions WHERE id = ${second}`;
    expect(unclaimed?.completing_at).toBeNull();
    const retried = await complete(second);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ version: 2 });
  });
});

describe("host links follow what is served", () => {
  it("unlinks a removed domain and a deactivated page, relinks on reactivation, and an external page is never linked", async () => {
    const page = await newPage();
    const keep = `keep-${suffix()}.example.com`;
    const drop = `drop-${suffix()}.example.com`;
    await as(() => registerDomain(rt.sql, page.id, keep, "example.test"));
    await as(() => registerDomain(rt.sql, page.id, drop, "example.test"));
    await publish(page.id, site("live"));
    expect(await served(drop)).toContain("live");
    const [d] = await root<{ id: string }[]>`SELECT id FROM lp_domains WHERE host = ${drop}`;
    await as(() => removeDomain(rt.sql, page.id, d?.id ?? ""));
    expect((await syncLpHosts(rt.sql, settings)).leftAlone).toBe(0);
    expect(await exists(join(lpDir, "hosts", drop))).toBe(false);
    expect(await served(keep)).toContain("live");

    await as(() => updateLandingPageSettings(rt.sql, page.id, { programId: page.programId, active: false, adnetIds: [] }));
    await syncLpHosts(rt.sql, settings);
    expect(await exists(join(lpDir, "hosts", keep))).toBe(false);
    await as(() => updateLandingPageSettings(rt.sql, page.id, { programId: page.programId, active: true, adnetIds: [] }));
    await syncLpHosts(rt.sql, settings);
    expect(await served(keep)).toContain("live");

    const external = await newPage();
    const ext = `ext-${suffix()}.example.com`;
    await as(() => registerDomain(rt.sql, external.id, ext, "example.test"));
    await syncLpHosts(rt.sql, settings);
    expect(await exists(join(lpDir, "hosts", ext))).toBe(false);
  });

  it("leaves entries that are not its own alone (logged), and is a no-op when nothing changed", async () => {
    const foreignHost = `foreign-${suffix()}.example.com`;
    await mkdir(join(lpDir, "hosts", foreignHost), { recursive: true });
    await writeFile(join(lpDir, "hosts", foreignHost, "notes.txt"), "not ours");
    // Our `current` in that unserved folder goes anyway: a removed page never keeps serving.
    const target = join(lpDir, "versions");
    await mkdir(target, { recursive: true });
    if (process.platform === "win32") await symlink(target, join(lpDir, "hosts", foreignHost, "current"), "junction");
    else await symlink("../../versions", join(lpDir, "hosts", foreignHost, "current"));
    await writeFile(join(lpDir, "hosts", "NOT A HOST"), "x");
    const result = await syncLpHosts(rt.sql, settings);
    expect(result.leftAlone).toBe(2);
    expect(await readFile(join(lpDir, "hosts", foreignHost, "notes.txt"), "utf8")).toBe("not ours");
    expect(await exists(join(lpDir, "hosts", foreignHost, "current"))).toBe(false);
    await rm(join(lpDir, "hosts", foreignHost), { recursive: true });
    await rm(join(lpDir, "hosts", "NOT A HOST"));
    const again = await syncLpHosts(rt.sql, settings);
    expect(again.linked + again.removed + again.leftAlone).toBe(0);
  });

  it("sweeps a crashed publish's leftovers once they are old enough, never a live version", async () => {
    const page = await newPage();
    await publish(page.id, site("live"));
    const stale = join(lpDir, ".staging", randomUUID());
    await mkdir(stale, { recursive: true });
    const orphan = join(lpDir, "versions", page.id, "99");
    await mkdir(orphan, { recursive: true });
    expect(await sweepLpFiles(rt.sql, settings)).toBe(0);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stale, old, old);
    await utimes(orphan, old, old);
    await utimes(join(lpDir, "versions", page.id, "1"), old, old);
    expect(await sweepLpFiles(rt.sql, settings)).toBe(2);
    expect(await exists(stale)).toBe(false);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(join(lpDir, "versions", page.id, "1", "index.html"))).toBe(true);
  });
});

describe("review fixes (US-023 round 1)", () => {
  it("never deletes a version a host link still points at, and deletes it once nothing does", async () => {
    const page = await newPage();
    for (let i = 1; i <= LP_VERSION_RETENTION; i++) await publish(page.id, site(`v${String(i)}`));
    // A sixth live version (written directly: no relink runs), and a link that still points at version 1.
    const [upload] = await root<{ id: string }[]>`
      INSERT INTO uploads (kind, storage_path, content_type, size_bytes, sha256) VALUES ('lp_zip', ${`lp-zips/${randomUUID()}.zip`}, 'application/zip', 1, sha256('6'::bytea)) RETURNING id`;
    const [v6] = await root<{ id: string }[]>`
      INSERT INTO lp_versions (landing_page_id, version, upload_id, file_count, uncompressed_bytes) VALUES (${page.id}, 6, ${upload?.id ?? ""}, 1, 1) RETURNING id`;
    await mkdir(join(lpDir, "versions", page.id, "6"), { recursive: true });
    await root`UPDATE landing_pages SET current_version_id = ${v6?.id ?? ""} WHERE id = ${page.id}`;
    const stale = join(lpDir, "hosts", `stale-${suffix()}.example.com`);
    await mkdir(stale, { recursive: true });
    const v1dir = join(lpDir, "versions", page.id, "1");
    if (process.platform === "win32") await symlink(v1dir, join(stale, "current"), "junction");
    else await symlink(`../../versions/${page.id}/1`, join(stale, "current"));
    expect(await as(() => purgeOldVersions(rt.sql, settings, page.id))).toBe(0);
    expect(await exists(join(v1dir, "index.html"))).toBe(true);
    // Once the link is gone (the relink removes it: that host is not served), version 1 goes.
    expect((await syncLpHosts(rt.sql, settings)).leftAlone).toBe(0);
    expect(await exists(stale)).toBe(false);
    expect(await as(() => purgeOldVersions(rt.sql, settings, page.id))).toBe(1);
    expect(await exists(v1dir)).toBe(false);
  });

  it("switches a page back to external: audited, links removed, NOTIFY sent, versions kept for later", async () => {
    const page = await newPage();
    const host = `back-${suffix()}.example.com`;
    await as(() => registerDomain(rt.sql, page.id, host, "example.test"));
    await publish(page.id, site("zip"));
    const listener = rt.sql;
    const heard: string[] = [];
    const sub = await listener.listen("lp_domains_changed", (payload) => heard.push(payload));
    await as(() => stopLpHosting(rt.sql, settings, page.id));
    expect(await exists(join(lpDir, "hosts", host))).toBe(false);
    expect(await root`SELECT 1 FROM lp_served_hosts() WHERE landing_page_id = ${page.id}`).toHaveLength(0);
    await expect.poll(() => heard.includes("UPDATE"), { timeout: 5000 }).toBe(true);
    await sub.unlisten();
    expect(await auditActions(page.id)).toEqual(["lp_version.publish", "lp_hosting.stop"]);
    const [v] = await root<{ id: string }[]>`SELECT id FROM lp_versions WHERE landing_page_id = ${page.id}`;
    await as(() => activateLpVersion(rt.sql, settings, page.id, v?.id ?? ""));
    expect(await served(host)).toContain("zip");
    const external = await newPage();
    await expect(as(() => stopLpHosting(rt.sql, settings, external.id))).rejects.toThrow(InvalidInput);
  });

  it("a failed finish after the commit is only logged: the session stays claimed, so it cannot publish twice", async () => {
    const page = await newPage();
    const zip = site("once");
    const sha = createHash("sha256").update(zip).digest("hex");
    const init = await as(() => initLpZipUpload(rt.sql, settings, ownerId, { landingPageId: page.id, filename: "s.zip", size: zip.length, sha256: sha }));
    if (init.kind !== "ready") throw new Error(init.kind);
    await as(() => writeChunk(rt.sql, settings, ownerId, { kind: "lp_zip", sessionId: init.sessionId, index: 0, sha256: sha, bytes: zip }));
    const result = await as(() => completeLpZipUpload(rt.sql, settings, ownerId, init.sessionId, { beforeFinish: () => Promise.reject(new Error("disk gone")) }));
    expect(result.version).toBe(1);
    const [session] = await root<{ completing_at: Date | null; completed_at: Date | null }[]>`SELECT completing_at, completed_at FROM upload_sessions WHERE id = ${init.sessionId}`;
    expect(session?.completing_at).not.toBeNull();
    expect(session?.completed_at).toBeNull();
    await expect(as(() => completeLpZipUpload(rt.sql, settings, ownerId, init.sessionId))).rejects.toThrow(InvalidInput);
    expect(await root`SELECT 1 FROM lp_versions WHERE landing_page_id = ${page.id}`).toHaveLength(1);
  });

  it("the sweep waits for the hosting lock (no publish is half-way under it)", async () => {
    let release = (): void => undefined;
    const held = root.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('lp_hosting', 0))`;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let done = false;
    const sweep = sweepLpFiles(rt.sql, settings).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    release();
    await held;
    await sweep;
    expect(done).toBe(true);
  });

  it(`raises one alert after ${String(RELINK_ALERT_AFTER)} failed relinks in a row`, async () => {
    expect(await syncLpHostsQuietly(rt.sql, settings)).toBe(true);
    const broken = join(dataDir, `not-a-dir-${suffix()}`);
    await writeFile(broken, "x");
    const bad: SettingsConfig = { ...settings, lpDir: broken };
    const before = (await root`SELECT 1 FROM alerts WHERE kind = 'lp_relink_failed'`).length;
    for (let i = 0; i < RELINK_ALERT_AFTER + 1; i++) expect(await syncLpHostsQuietly(rt.sql, bad)).toBe(false);
    expect((await root`SELECT 1 FROM alerts WHERE kind = 'lp_relink_failed' AND source = 'admin'`).length).toBe(before + 1);
    expect(await syncLpHostsQuietly(rt.sql, settings)).toBe(true);
  });
});
