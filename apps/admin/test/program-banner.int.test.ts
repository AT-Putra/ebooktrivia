// The picture the Owner uploads for a program's banner card (POST /uploads/image/banner, lib/settings/programs.ts setProgramBanner),
// against the real PostgreSQL and a temporary data directory:
//   - the upload is re-encoded to WebP under images/ (the directory the public app mounts) with a DISPLAY COPY that fits 1344 x 448
//     (never enlarged), linked on the program and audited with the upload ids before / after (never the file name);
//   - replacing it keeps the old file and uploads row (a clone may use it), removing it clears the link, and a clone shares it;
//   - the role is the Owner's alone (program.edit; Staff are refused 403 by the handler too); an unknown program, an SVG, an unexpected
//     query parameter and a file that is not an image are refused and leave no file behind;
//   - a banner may change on a locked program (a paid order) and on a finalized one: it is cosmetic, not a contest field.
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { solidPng, webpSize } from "./image-fixtures.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";
import { decide } from "../src/lib/access.ts";
import { bannerImage } from "../src/lib/next/content-routes.ts";
import type { RouteContext } from "../src/lib/next/route.ts";
import { NO_SETTINGS } from "../src/lib/settings/env.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { bannerPreviewSrc, PREVIEW_MAX_BYTES } from "../src/lib/settings/image-preview.ts";
import { listProgramPrizes } from "../src/lib/settings/prizes.ts";
import { cloneProgram, listPrograms, setProgramBanner } from "../src/lib/settings/programs.ts";

type Id = { id: string };
let dataDir = "";
let rt: ReturnType<typeof newRuntime>;
let owner: { userId: string };
let staff: { userId: string };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-admin-banner-"));
  rt = newRuntime(undefined, { ...NO_SETTINGS, dataDir });
  owner = { userId: (await createTestAdmin(rt, "owner")).userId };
  staff = { userId: (await createTestAdmin(rt, "staff")).userId };
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};
/** A program (a draft unless `status` says otherwise: "finalized" is inserted as such, its results are not needed here). */
const program = async (status: "draft" | "finalized" = "draft"): Promise<string> => {
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const p = await one(root<Id[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`banner-${suffix()}`}, 'Musim Banner', ${status}, now() - interval '90 days', ${status === "draft" ? root`now() + interval '30 days'` : root`now() - interval '40 days'`}, 30) RETURNING id`);
  return p.id;
};

/** Tests that need what a developer's machine may lack (a symbolic link on Windows without the privilege): skipped there, a FAILURE in CI. */
function requireOrSkip(context: Pick<TestContext, "skip">, available: boolean, why: string): void {
  if (available) return;
  if ((process.env["CI"] ?? "") !== "") throw new Error(`CI must be able to run this test, but: ${why}`);
  context.skip(why);
}
const files = async (): Promise<string[]> => (await readdir(join(dataDir, "images")).catch(() => [])).sort();
const filesOf = async (uploadId: string): Promise<string[]> => (await files()).filter((name) => name.includes(uploadId));

const ctx = (userId: string, role: "owner" | "staff" = "owner"): RouteContext => ({ rt, req: { headers: new Headers(), ip: null }, admin: { userId, sessionId: "s", role, displayName: "x" } });
const postAs = (actor: { userId: string }, role: "owner" | "staff", programId: string, bytes: Uint8Array, type = "image/png", name = "banner.png", query = `program=${programId}`) =>
  asAdmin(actor.userId, () => bannerImage(ctx(actor.userId, role), new Request(`http://admin.test/uploads/image/banner?${query}`, { method: "POST", headers: { "content-type": type, "x-file-name": name }, body: Buffer.from(bytes) })));
const post = (programId: string, bytes: Uint8Array, type = "image/png", name = "banner.png", query = `program=${programId}`) => postAs(owner, "owner", programId, bytes, type, name, query);
const bannerOf = async (programId: string) =>
  one(root<{ id: string | null; path: string | null; type: string | null; kind: string | null }[]>`
    SELECT p.banner_upload_id AS id, u.storage_path AS path, u.content_type AS type, u.kind FROM programs p LEFT JOIN uploads u ON u.id = p.banner_upload_id WHERE p.id = ${programId}`);

describe("a program's banner picture", () => {
  it("is stored under images/ with a display copy that fits 1344 x 448 (never enlarged), linked on the program and audited", async () => {
    const programId = await program();
    expect((await bannerOf(programId)).id).toBeNull();
    const response = await post(programId, solidPng(1800, 600));
    expect(response.status).toBe(200);
    const banner = await bannerOf(programId);
    expect(banner).toMatchObject({ type: "image/webp", kind: "image" });
    expect(banner.path).toBe(`images/${banner.id}.webp`);
    expect(webpSize(await readFile(join(dataDir, banner.path ?? "")))).toEqual({ width: 1800, height: 600 });
    expect(webpSize(await readFile(join(dataDir, `images/${banner.id}.display.webp`)))).toEqual({ width: 1344, height: 448 });
    expect(await filesOf(banner.id ?? "")).toEqual([`${banner.id}.display.webp`, `${banner.id}.webp`]);
    // A small picture is not enlarged; a square one fits the height of the box.
    await post(programId, solidPng(600, 200));
    const small = await bannerOf(programId);
    expect(webpSize(await readFile(join(dataDir, `images/${small.id}.display.webp`)))).toEqual({ width: 600, height: 200 });
    await post(programId, solidPng(1000, 1000));
    const square = await bannerOf(programId);
    expect(webpSize(await readFile(join(dataDir, `images/${square.id}.display.webp`)))).toEqual({ width: 448, height: 448 });
    // Audited: the upload ids before and after, who did it, never the file name.
    const audit = await one(root<{ changes: Record<string, unknown>; text: string; actor: string }[]>`
      SELECT changes, row_to_json(a)::text AS text, actor_admin_user_id AS actor FROM audit_log a WHERE action = 'program.banner' AND entity_id = ${programId} ORDER BY id DESC LIMIT 1`);
    expect(audit.changes).toMatchObject({ banner_upload_id: { before: small.id, after: square.id } });
    expect(Number(audit.changes["size_bytes"])).toBeGreaterThan(0);
    expect(audit.actor).toBe(owner.userId);
    expect(audit.text).not.toContain("banner.png");
  });

  it("keeps the old file and uploads row when replaced, and clears the link (only) when removed", async () => {
    const programId = await program();
    await post(programId, solidPng(1500, 500));
    const first = await bannerOf(programId);
    await post(programId, solidPng(1500, 500));
    const second = await bannerOf(programId);
    expect(second.id).not.toBe(first.id);
    expect(await filesOf(first.id ?? "")).toHaveLength(2);
    expect(await one(root<{ n: number }[]>`SELECT count(*)::int AS n FROM uploads WHERE id = ${first.id}`)).toEqual({ n: 1 });
    await asAdmin(owner.userId, () => setProgramBanner(rt.sql, owner.userId, programId, null));
    expect((await bannerOf(programId)).id).toBeNull();
    expect(await filesOf(second.id ?? "")).toHaveLength(2);
    const audit = await one(root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'program.banner' AND entity_id = ${programId} ORDER BY id DESC LIMIT 1`);
    expect(audit.changes).toMatchObject({ banner_upload_id: { before: second.id, after: null } });
    // Nothing left to remove.
    await expect(asAdmin(owner.userId, () => setProgramBanner(rt.sql, owner.userId, programId, null))).rejects.toThrow(InvalidInput);
  });

  it("is previewed on the admin page from its display copy (a data URI, the original while there is no copy), and from nothing that is not its own file", async () => {
    const programId = await program();
    await post(programId, solidPng(1800, 600));
    const banner = await bannerOf(programId);
    const id = banner.id ?? "";
    const display = await readFile(join(dataDir, `images/${id}.display.webp`));
    expect(await bannerPreviewSrc(dataDir, id)).toBe(`data:image/webp;base64,${display.toString("base64")}`);
    await rm(join(dataDir, `images/${id}.display.webp`));
    const original = await readFile(join(dataDir, `images/${id}.webp`));
    expect(await bannerPreviewSrc(dataDir, id)).toBe(`data:image/webp;base64,${original.toString("base64")}`);
    await rm(join(dataDir, `images/${id}.webp`));
    expect(await bannerPreviewSrc(dataDir, id)).toBeNull();
    expect(await bannerPreviewSrc(null, id)).toBeNull();
    expect(await bannerPreviewSrc(dataDir, "../../etc/passwd")).toBeNull();
  });

  it("is shown in the programs list (the admin page), and a clone of the program shares it", async () => {
    const programId = await program();
    await post(programId, solidPng(1500, 500));
    const banner = await bannerOf(programId);
    expect((await listPrograms(rt.sql)).find((p) => p.id === programId)?.bannerUploadId).toBe(banner.id);
    const copy = await asAdmin(owner.userId, () => cloneProgram(rt.sql, programId, { slug: `copy-${suffix()}`, name: "Salinan" }));
    expect((await bannerOf(copy)).id).toBe(banner.id);
  });

  it("lists the highest rank any prize tier covers next to the leaderboard size (what the Programs page's leaderboard hint reads)", async () => {
    const programId = await program();
    expect((await listPrograms(rt.sql)).find((p) => p.id === programId)).toMatchObject({ prizeRanks: 0, leaderboardTopN: 10 });
    await root`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, 1, 1, 'Juara 1', 1000000), (${programId}, 2, 6, 'Juara 2-6', 500000)`;
    expect((await listPrograms(rt.sql)).find((p) => p.id === programId)).toMatchObject({ prizeRanks: 6, leaderboardTopN: 10 });
    // The Prize tiers page reads the same number from the same SQL.
    expect((await listProgramPrizes(rt.sql)).find((p) => p.id === programId)).toMatchObject({ prizeRanks: 6, leaderboardTopN: 10 });
  });

  it("is the Owner's alone: program.edit; the handler refuses Staff with 403 and writes nothing, whatever the route's guard says", async () => {
    const identity = (role: "owner" | "staff") => ({ userId: owner.userId, sessionId: "s", role, displayName: "x" });
    expect(decide({ status: "active", admin: identity("owner") }, { permission: "program.edit" })).toMatchObject({ kind: "allow" });
    expect(decide({ status: "active", admin: identity("staff") }, { permission: "program.edit" })).toEqual({ kind: "forbidden" });
    expect(decide({ status: "anonymous" }, { permission: "program.edit" })).toEqual({ kind: "redirect", to: "/login" });
    const programId = await program();
    const before = await files();
    const refused = await postAs(staff, "staff", programId, solidPng(1500, 500));
    expect(refused.status).toBe(403);
    expect((await refused.json()) as unknown).toEqual({ error: expect.stringContaining("Owner") as unknown });
    expect((await bannerOf(programId)).id).toBeNull();
    expect(await files()).toEqual(before);
    expect(await one(root<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'program.banner' AND entity_id = ${programId}`)).toEqual({ n: 0 });
  });

  it("may change on a locked program (a paid order stamps locked_at) and on a finalized one: set, replace and remove all work", async () => {
    const locked = await program();
    await root`UPDATE programs SET locked_at = clock_timestamp() WHERE id = ${locked}`;
    const finalized = await program("finalized");
    for (const programId of [locked, finalized]) {
      expect((await post(programId, solidPng(1500, 500))).status, "set").toBe(200);
      const first = (await bannerOf(programId)).id;
      expect(first).not.toBeNull();
      expect((await post(programId, solidPng(1800, 600))).status, "replace").toBe(200);
      expect((await bannerOf(programId)).id).not.toBe(first);
      await asAdmin(owner.userId, () => setProgramBanner(rt.sql, owner.userId, programId, null));
      expect((await bannerOf(programId)).id, "remove").toBeNull();
    }
    // The lock itself is untouched by a banner change.
    expect((await one(root<{ locked: boolean }[]>`SELECT locked_at IS NOT NULL AS locked FROM programs WHERE id = ${locked}`)).locked).toBe(true);
  });

  it("records the banner a clone starts with in the program.clone audit (and the clone shares the picture)", async () => {
    const source = await program();
    await post(source, solidPng(1500, 500));
    const banner = (await bannerOf(source)).id;
    const copy = await asAdmin(owner.userId, () => cloneProgram(rt.sql, source, { slug: `copy-${suffix()}`, name: "Salinan Audit" }));
    expect((await bannerOf(copy)).id).toBe(banner);
    const audit = await one(root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'program.clone' AND entity_id = ${copy} ORDER BY id DESC LIMIT 1`);
    expect(audit.changes).toMatchObject({ banner_upload_id: { after: banner }, cloned_from: source });
    // A source without a banner records nothing for it (an empty field is not a change).
    const plain = await program();
    const plainCopy = await asAdmin(owner.userId, () => cloneProgram(rt.sql, plain, { slug: `copy-${suffix()}`, name: "Salinan Polos" }));
    const none = await one(root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'program.clone' AND entity_id = ${plainCopy} ORDER BY id DESC LIMIT 1`);
    expect(none.changes).not.toHaveProperty("banner_upload_id");
  });

  it("is not previewed when the file is larger than the cap (256 KB): the page just says it is uploaded; one within the cap is", async () => {
    const programId = await program();
    await post(programId, solidPng(1500, 500));
    const id = (await bannerOf(programId)).id ?? "";
    await rm(join(dataDir, `images/${id}.webp`));
    await rm(join(dataDir, `images/${id}.display.webp`));
    expect(PREVIEW_MAX_BYTES).toBe(256 * 1024);
    // Something that is not a regular file at the name (a directory here; a link is the next test) is no preview.
    await mkdir(join(dataDir, `images/${id}.display.webp`));
    expect(await bannerPreviewSrc(dataDir, id)).toBeNull();
    await rm(join(dataDir, `images/${id}.display.webp`), { recursive: true });
    await writeFile(join(dataDir, `images/${id}.display.webp`), Buffer.alloc(PREVIEW_MAX_BYTES + 1));
    expect(await bannerPreviewSrc(dataDir, id)).toBeNull();
    await writeFile(join(dataDir, `images/${id}.display.webp`), Buffer.alloc(PREVIEW_MAX_BYTES));
    expect(await bannerPreviewSrc(dataDir, id)).toMatch(/^data:image\/webp;base64,/);
  });

  it("is not previewed through a symbolic link at the file's name (the file it points at is never read); skipped only on a machine that cannot make one, never in CI", async (context) => {
    const programId = await program();
    await post(programId, solidPng(1500, 500));
    const id = (await bannerOf(programId)).id ?? "";
    const target = join(dataDir, `elsewhere-${suffix()}.webp`);
    await writeFile(target, await readFile(join(dataDir, `images/${id}.webp`)));
    await rm(join(dataDir, `images/${id}.display.webp`));
    await rm(join(dataDir, `images/${id}.webp`));
    let linked = true;
    try {
      await symlink(target, join(dataDir, `images/${id}.display.webp`));
      await symlink(target, join(dataDir, `images/${id}.webp`));
    } catch {
      linked = false;
    }
    requireOrSkip(context, linked, "this machine cannot create symbolic links (Windows without the privilege)");
    expect(await bannerPreviewSrc(dataDir, id)).toBeNull();
  });

  it("refuses an unknown program, an SVG, a file that is no image, an empty body and any other query parameter, leaving no file behind", async () => {
    const programId = await program();
    const before = await files();
    const unknown = await post("3f0f2a64-0c0d-4f0b-9e7b-4d1d4f6c9a11", solidPng(1500, 500));
    expect(unknown.status).toBe(400);
    const svg = await post(programId, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "x.svg");
    expect(svg.status).toBe(400);
    expect(await post(programId, Buffer.from("not an image"), "image/png", "x.png").then((r) => r.status)).toBe(400);
    expect(await post(programId, new Uint8Array(0)).then((r) => r.status)).toBe(400);
    expect(await post(programId, solidPng(1500, 500), "image/png", "x.png", `program=${programId}&path=../../etc`).then((r) => r.status)).toBe(400);
    expect(await post("not-a-uuid", solidPng(1500, 500), "image/png", "x.png", "program=not-a-uuid").then((r) => r.status)).toBe(400);
    expect((await bannerOf(programId)).id).toBeNull();
    expect(await files()).toEqual(before);
  });

  it("removes the stored files when linking fails (the program vanished between the check and the link)", async () => {
    const programId = await program();
    const before = await files();
    // Delete the program after the route's pre-check by linking an image stored for it directly.
    const { storeImage } = await import("../src/lib/settings/images.ts");
    const stored = await storeImage({ ...NO_SETTINGS, dataDir }, { bytes: solidPng(1500, 500), filename: "x.png", mimeType: "image/png" }, "banner");
    expect(await filesOf(stored.uploadId)).toHaveLength(2);
    await root`DELETE FROM programs WHERE id = ${programId}`;
    await expect(asAdmin(owner.userId, () => setProgramBanner(rt.sql, owner.userId, programId, stored))).rejects.toThrow(InvalidInput);
    expect(await files()).toEqual(before);
  });
});
