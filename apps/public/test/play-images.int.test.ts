// The pictures the Owner uploads for the play pages, as the play origin serves them (lib/play/images.ts), against the real
// PostgreSQL (public_rw login, with its column-level read of uploads), the real Valkey (ACL user `public`) and WebP files on disk
// (a temporary data directory):
//   - a set's thumbnail and a prize tier's image are public, but only through the owning row (the URL names the row AND its own
//     upload id), only for a program that is not a draft, only the DISPLAY copy (the original while a copy is missing);
//   - a question's image is never served: its upload is not the row's thumbnail or prize image, and its path is not images/<id>.webp;
//   - anything else (an unknown id, another upload, another kind or type, a path that is not the upload's own, a file that is not
//     on the disk or is a link, a malformed or traversing path) is the same bare 404;
//   - the lookup is one cached query; only a cache MISS is counted against the client (300 a minute), failing open without Valkey.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPublicSql } from "../src/lib/db.ts";
import { createImageCache, type ImageCache } from "../src/lib/play/image-cache.ts";
import { prizeImageUrl, setImageUrl } from "../src/lib/play/image-urls.ts";
import { IMAGE_MISS_LIMIT, type ImageDeps, ownedImageHandler } from "../src/lib/play/images.ts";
import type { Valkey } from "../src/lib/valkey.ts";
import { requireOrSkip } from "./capabilities.ts";
import { captureLog, freshIp, one, publicSql, root, suffix, valkey } from "./support.ts";

let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-images-"));
  for (const dir of ["images", "question-images", "deliverables"]) await mkdir(join(dataDir, dir), { recursive: true });
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const logs = captureLog();
const deps = (overrides: Partial<ImageDeps> = {}): ImageDeps => ({ sql: publicSql, valkey, log: logs.log, dataDir, ...overrides });
const setHandler = (cache: ImageCache = createImageCache()) => ownedImageHandler("set", cache);
const prizeHandler = (cache: ImageCache = createImageCache()) => ownedImageHandler("prize", cache);

interface Stored {
  readonly id: string;
  readonly original: Buffer;
  readonly display: Buffer;
}

/** A WebP-looking original under images/ with its uploads row, and (unless `display` is false) a different, smaller display copy next to it. */
async function upload(options: { readonly kind?: string; readonly contentType?: string; readonly path?: string; readonly display?: boolean; readonly onDisk?: boolean } = {}): Promise<Stored> {
  const id = randomUUID();
  const original = Buffer.concat([Buffer.from("RIFF"), randomBytes(2048), Buffer.from("WEBP")]);
  const display = Buffer.concat([Buffer.from("RIFF"), randomBytes(256), Buffer.from("WEBP")]);
  const storagePath = options.path ?? `images/${id}.webp`;
  await root`
    INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256)
    VALUES (${id}, ${options.kind ?? "image"}, ${storagePath}, ${options.contentType ?? "image/webp"}, ${original.length}, ${randomBytes(32)})`;
  if (options.onDisk !== false) {
    await writeFile(join(dataDir, storagePath), original);
    if (options.display !== false) await writeFile(join(dataDir, `images/${id}.display.webp`), display);
  }
  return { id, original, display };
}

interface Content {
  readonly programId: string;
  readonly setId: string;
  readonly thumbnail: Stored;
  readonly tierId: string;
  readonly prize: Stored;
  readonly questionImage: Stored;
}

/** A program (`status`, on sale now) with a set that has a thumbnail, a prize tier with an image and a question with its own picture. */
async function program(status: string): Promise<Content> {
  const product = await one(root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const p = await one(root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`prog-${suffix()}`}, 'Program', ${status === "draft" ? "draft" : "published"}, now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`);
  const thumbnail = await upload();
  const prize = await upload();
  // A question's picture is stored where the admin app puts it (question-images/), not under images/.
  const questionImageId = randomUUID();
  const questionBytes = Buffer.concat([Buffer.from("RIFF"), randomBytes(512), Buffer.from("WEBP")]);
  await root`
    INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256)
    VALUES (${questionImageId}, 'image', ${`question-images/${questionImageId}.webp`}, 'image/webp', ${questionBytes.length}, ${randomBytes(32)})`;
  await writeFile(join(dataDir, `question-images/${questionImageId}.webp`), questionBytes);
  const set = await one(root<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title, thumbnail_upload_id) VALUES (${p.id}, 1, 'Set 1', ${thumbnail.id}) RETURNING id`);
  const tier = await one(root<{ id: string }[]>`
    INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr, image_upload_id) VALUES (${p.id}, 1, 1, 'Juara 1', 1000000, ${prize.id}) RETURNING id`);
  await root`INSERT INTO questions (set_id, position, prompt, points, timer_seconds, image_upload_id) VALUES (${set.id}, 1, 'Soal?', 10, 20, ${questionImageId})`;
  if (status !== "draft" && status !== "published") await root`UPDATE programs SET status = ${status} WHERE id = ${p.id}`;
  return { programId: p.id, setId: set.id, thumbnail, tierId: tier.id, prize, questionImage: { id: questionImageId, original: questionBytes, display: questionBytes } };
}

const get = (path: string, headers: Record<string, string> = {}, method = "GET"): Request => new Request(`https://play.example.test${path}`, { method, headers: { "x-forwarded-for": freshIp(), ...headers } });
const bodyOf = async (response: Response): Promise<Buffer> => Buffer.from(await response.arrayBuffer());
const expectBare404 = async (response: Response): Promise<void> => {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect((await bodyOf(response)).length).toBe(0);
};

describe("a set's thumbnail and a prize tier's image (public)", () => {
  let published: Content;
  beforeAll(async () => {
    published = await program("published");
  });

  it("serves the DISPLAY copy through the owning row: a fixed image/webp, nosniff, immutable for a year, never a cookie", async () => {
    for (const [handler, url, file] of [
      [setHandler(), setImageUrl(published.setId, published.thumbnail.id), published.thumbnail],
      [prizeHandler(), prizeImageUrl(published.tierId, published.prize.id), published.prize],
    ] as const) {
      const response = await handler(deps(), get(url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("content-length")).toBe(String(file.display.length));
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = await bodyOf(response);
      expect(body.equals(file.display)).toBe(true);
      expect(body.equals(file.original)).toBe(false);
    }
  });

  it("answers a HEAD request with the headers of the GET (the length of the display copy) and no body, closing the file", async () => {
    const url = setImageUrl(published.setId, published.thumbnail.id);
    const head = await setHandler()(deps(), get(url, {}, "HEAD"));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/webp");
    expect(head.headers.get("content-length")).toBe(String(published.thumbnail.display.length));
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await bodyOf(head)).length).toBe(0);
    // And a HEAD for what a GET refuses is the same bare 404.
    expect((await setHandler()(deps(), get(setImageUrl(published.setId, randomUUID()), {}, "HEAD"))).status).toBe(404);
  });

  it("serves the original while there is no display copy yet (not backfilled), saying so in the log", async () => {
    const lines = captureLog();
    const content = await program("published");
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${(await upload({ display: false })).id} WHERE id = ${content.setId}`;
    const [row] = await root<{ id: string }[]>`SELECT thumbnail_upload_id AS id FROM trivia_sets WHERE id = ${content.setId}`;
    const response = await setHandler()(deps({ log: lines.log }), get(setImageUrl(content.setId, row?.id ?? "")));
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).length).toBeGreaterThan(2000);
    expect(lines.lines.join("\n")).toContain("display_missing");
    expect(lines.lines.join("\n")).not.toContain(row?.id ?? "unreachable");
  });

  it("says once per upload and instance that the display copy is missing, not on every request", async () => {
    const lines = captureLog();
    const first = await program("published");
    const second = await program("published");
    const bare = async (content: Content) => {
      const id = (await upload({ display: false })).id;
      await root`UPDATE trivia_sets SET thumbnail_upload_id = ${id} WHERE id = ${content.setId}`;
      return setImageUrl(content.setId, id);
    };
    const [urlA, urlB] = [await bare(first), await bare(second)];
    const handler = setHandler();
    for (let i = 0; i < 3; i++) expect((await handler(deps({ log: lines.log }), get(urlA))).status).toBe(200);
    const warnings = () => lines.lines.filter((line) => line.includes("display_missing")).length;
    expect(warnings()).toBe(1);
    expect((await handler(deps({ log: lines.log }), get(urlB))).status).toBe(200);
    expect(warnings()).toBe(2);
    // Another instance (a handler of its own) says it again once.
    expect((await setHandler()(deps({ log: lines.log }), get(urlA))).status).toBe(200);
    expect(warnings()).toBe(3);
  });

  it("needs no session (a cookie is neither required nor read)", async () => {
    const response = await setHandler()(deps(), get(setImageUrl(published.setId, published.thumbnail.id), { cookie: "__Host-play_session=garbage" }));
    expect(response.status).toBe(200);
  });

  it("serves a program that is published or later (awaiting confirmation), and answers 404 for a draft until it is published", async () => {
    const later = await program("awaiting_confirmation");
    expect((await setHandler()(deps(), get(setImageUrl(later.setId, later.thumbnail.id)))).status).toBe(200);
    expect((await prizeHandler()(deps(), get(prizeImageUrl(later.tierId, later.prize.id)))).status).toBe(200);
    const draft = await program("draft");
    const set = setHandler();
    await expectBare404(await set(deps(), get(setImageUrl(draft.setId, draft.thumbnail.id))));
    await expectBare404(await prizeHandler()(deps(), get(prizeImageUrl(draft.tierId, draft.prize.id))));
    await root`UPDATE programs SET status = 'published' WHERE id = ${draft.programId}`;
    // The "not found" was not remembered: the very next request, with the same cache, sees the published program.
    expect((await set(deps(), get(setImageUrl(draft.setId, draft.thumbnail.id)))).status).toBe(200);
    expect((await prizeHandler()(deps(), get(prizeImageUrl(draft.tierId, draft.prize.id)))).status).toBe(200);
  });

  it("is 404 for a question's picture, however it is asked for: under a set's or a prize's URL, and as the row's own image", async () => {
    const q = published.questionImage.id;
    await expectBare404(await setHandler()(deps(), get(setImageUrl(published.setId, q))));
    await expectBare404(await prizeHandler()(deps(), get(prizeImageUrl(published.tierId, q))));
    // Even if an Owner's mistake (or a clone) made it a set's thumbnail, the path is question-images/..., not images/<id>.webp.
    const content = await program("published");
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${content.questionImage.id} WHERE id = ${content.setId}`;
    await expectBare404(await setHandler()(deps(), get(setImageUrl(content.setId, content.questionImage.id))));
    await root`UPDATE prize_tiers SET image_upload_id = ${content.questionImage.id} WHERE id = ${content.tierId}`;
    await expectBare404(await prizeHandler()(deps(), get(prizeImageUrl(content.tierId, content.questionImage.id))));
  });

  it("is 404 for an upload id that is not the owning row's own (another upload), an unknown owner or upload, and a row's id for the other kind", async () => {
    const otherUpload = await upload();
    const set = setHandler();
    const prize = prizeHandler();
    for (const uploadId of [otherUpload.id, randomUUID(), published.prize.id]) await expectBare404(await set(deps(), get(setImageUrl(published.setId, uploadId))));
    for (const uploadId of [otherUpload.id, randomUUID(), published.thumbnail.id]) await expectBare404(await prize(deps(), get(prizeImageUrl(published.tierId, uploadId))));
    await expectBare404(await set(deps(), get(setImageUrl(randomUUID(), published.thumbnail.id))));
    await expectBare404(await prize(deps(), get(prizeImageUrl(randomUUID(), published.prize.id))));
    // A tier's id on the set route (and the reverse) is no row of that kind; a set URL given to the prize handler is no prize path.
    await expectBare404(await set(deps(), get(setImageUrl(published.tierId, published.thumbnail.id))));
    await expectBare404(await set(deps(), get(prizeImageUrl(published.tierId, published.prize.id))));
    await expectBare404(await prize(deps(), get(setImageUrl(published.setId, published.thumbnail.id))));
  });

  it("is 404 for a malformed path in any spelling: no traversal, no other extension, no query-chosen file, no non-canonical uuid", async () => {
    const good = setImageUrl(published.setId, published.thumbnail.id);
    const upper = (id: string) => id.toUpperCase();
    const paths = [
      good.replace(".webp", ".png"),
      good.replace(".webp", ".display.webp"),
      good.replace(".webp", ""),
      `${good}/extra`,
      good.toUpperCase(),
      // Non-canonical uuids: upper case, no hyphens, braces, a urn prefix, surrounding spaces.
      setImageUrl(upper(published.setId), published.thumbnail.id),
      setImageUrl(published.setId, upper(published.thumbnail.id)),
      setImageUrl(published.setId.replaceAll("-", ""), published.thumbnail.id),
      setImageUrl(`{${published.setId}}`, published.thumbnail.id),
      setImageUrl(`urn:uuid:${published.setId}`, published.thumbnail.id),
      setImageUrl(published.setId, ` ${published.thumbnail.id}`),
      good.replace(published.thumbnail.id, "..%2F..%2Fetc%2Fpasswd"),
      good.replace(published.thumbnail.id, "../../etc/passwd"),
      `/api/v1/play/img/set/${published.setId}/../${published.thumbnail.id}.webp`,
      `/api/v1/play/img/set/${published.setId}%2F${published.thumbnail.id}.webp`,
      "/api/v1/play/img/set/",
      "/api/v1/play/img/set/x/y.webp",
      "/api/v1/play/img/other/x/y.webp",
      // The question route does not exist: even a well-formed one is refused by this handler.
      `/api/v1/play/img/q/${randomUUID()}.webp`,
    ];
    for (const path of paths) await expectBare404(await setHandler()(deps(), get(path)));
    // A query string neither changes the file nor opens another.
    const withQuery = await setHandler()(deps(), get(`${good}?path=../../etc/passwd&file=x`));
    expect((await bodyOf(withQuery)).equals(published.thumbnail.display)).toBe(true);
  });

  it("is 404 for an upload that is not an image the upload policy made (another kind or type, a path that is not its own id's, outside images/) and for a file that is missing", async () => {
    const refused = [
      await upload({ kind: "pdf" }), // another kind
      await upload({ contentType: "image/png" }), // another type
      await upload({ path: `images/${randomUUID()}.webp` }), // a path that is another id's
      await upload({ path: `question-images/${randomUUID()}.webp` }), // a question image's directory
      await upload({ path: `deliverables/${randomUUID()}.webp` }), // a path outside images/
      await upload({ onDisk: false }), // no file at all
    ];
    for (const u of refused) {
      await root`UPDATE trivia_sets SET thumbnail_upload_id = ${u.id} WHERE id = ${published.setId}`;
      await expectBare404(await setHandler()(deps(), get(setImageUrl(published.setId, u.id))));
    }
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${published.thumbnail.id} WHERE id = ${published.setId}`;
    expect((await setHandler()(deps(), get(setImageUrl(published.setId, published.thumbnail.id)))).status).toBe(200);
  });

  it("answers a replaced thumbnail's old URL with 404 and the new one with the new file (the URL is the version)", async () => {
    const replaced = await upload();
    const oldUrl = setImageUrl(published.setId, published.thumbnail.id);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${replaced.id} WHERE id = ${published.setId}`;
    await expectBare404(await setHandler()(deps(), get(oldUrl)));
    const fresh = await setHandler()(deps(), get(setImageUrl(published.setId, replaced.id)));
    expect((await bodyOf(fresh)).equals(replaced.display)).toBe(true);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${published.thumbnail.id} WHERE id = ${published.setId}`;
  });

  it("answers 404 for a file that is a symbolic link, never following it; skipped only on a machine that cannot make one, never in CI", async (context) => {
    const content = await program("published");
    let made = true;
    try {
      await symlink(join(dataDir, `question-images/${content.questionImage.id}.webp`), join(dataDir, "probe-link"));
    } catch {
      made = false;
    }
    requireOrSkip(context, made, "this machine cannot create symbolic links (Windows without the privilege); lib/safe-file.test.ts covers the logic with faked calls");
    // The display copy is a link to a question image: it is not served, nor is the original behind it (the display one is the first choice, and a refusal of it falls back to the original, which is the real file).
    await rm(join(dataDir, `images/${content.thumbnail.id}.display.webp`));
    await symlink(join(dataDir, `question-images/${content.questionImage.id}.webp`), join(dataDir, `images/${content.thumbnail.id}.display.webp`));
    const response = await setHandler()(deps(), get(setImageUrl(content.setId, content.thumbnail.id)));
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).equals(content.thumbnail.original)).toBe(true);
    // The original as a link and no display copy: nothing at all.
    const other = await upload({ display: false });
    await rm(join(dataDir, `images/${other.id}.webp`));
    await symlink(join(dataDir, `question-images/${content.questionImage.id}.webp`), join(dataDir, `images/${other.id}.webp`));
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${other.id} WHERE id = ${content.setId}`;
    await expectBare404(await setHandler()(deps(), get(setImageUrl(content.setId, other.id))));
  });
});

describe("the lookup cache and the limit on its misses", () => {
  let content: Content;
  beforeAll(async () => {
    content = await program("published");
  });

  /** A Valkey that fails every command, to prove which paths use it. */
  const brokenValkey = { fcall: () => Promise.reject(new Error("connection refused")) } as unknown as Valkey;
  /** A Valkey that records every command sent to it (and fails it): what a request did with Valkey, if anything. */
  const recordingValkey = (): { readonly valkey: Valkey; readonly calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return { valkey: { fcall: (...args: unknown[]) => { calls.push(args); return Promise.reject(new Error("connection refused")); } } as unknown as Valkey, calls };
  };

  it("touches neither the database nor Valkey for a cache hit: the first request fills the cache, the next ones are served from it", async () => {
    const cache = createImageCache();
    const handler = setHandler(cache);
    const url = setImageUrl(content.setId, content.thumbnail.id);
    expect((await handler(deps(), get(url))).status).toBe(200);
    const noDatabase = createPublicSql(inject("publicDbUrl"), 1);
    await noDatabase.end();
    // A closed pool and a Valkey that records any use: a hit needs neither.
    const spy = recordingValkey();
    const hit = await handler(deps({ sql: noDatabase, valkey: spy.valkey }), get(url));
    expect(hit.status).toBe(200);
    expect(spy.calls).toEqual([]);
    expect((await bodyOf(hit)).equals(content.thumbnail.display)).toBe(true);
    // A cache of its own instance has nothing: it asks (and fails here, the pool being closed: 503, not a file).
    expect((await setHandler()(deps({ sql: noDatabase }), get(url))).status).toBe(503);
  });

  it("remembers only what was allowed (nothing negative), for a bounded time: an entry is stale for at most its TTL, a new cache sees the change", async () => {
    let now = 0;
    const cache = createImageCache({ ttlMs: 1000, now: () => now });
    const handler = setHandler(cache);
    const fresh = await program("published");
    const url = setImageUrl(fresh.setId, fresh.thumbnail.id);
    expect((await handler(deps(), get(url))).status).toBe(200);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = NULL WHERE id = ${fresh.setId}`;
    // Within the TTL the old answer stands (documented); after it, the database is asked again.
    expect((await handler(deps(), get(url))).status).toBe(200);
    now = 1000;
    await expectBare404(await handler(deps(), get(url)));
    // A 404 is not remembered: put the row back and the same cache serves it at once.
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${fresh.thumbnail.id} WHERE id = ${fresh.setId}`;
    expect((await handler(deps(), get(url))).status).toBe(200);
  });

  it("counts only misses against the client: 300 a minute per address, then 429 with Retry-After; hits are free, another address is not affected", async () => {
    const handler = setHandler();
    const ip = freshIp();
    const miss = () => handler(deps(), get(setImageUrl(randomUUID(), randomUUID()), { "x-forwarded-for": ip }));
    for (let i = 0; i < IMAGE_MISS_LIMIT.perIp; i++) expect((await miss()).status, `miss ${String(i + 1)}`).toBe(404);
    const refused = await miss();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect((await bodyOf(refused)).length).toBe(0);
    // This address is over its misses, but what is cached is served to it (no limit, no Valkey).
    const cached = createImageCache();
    const url = setImageUrl(content.setId, content.thumbnail.id);
    expect((await setHandler(cached)(deps(), get(url, { "x-forwarded-for": freshIp() }))).status).toBe(200);
    const spy = recordingValkey();
    expect((await setHandler(cached)(deps({ valkey: spy.valkey }), get(url, { "x-forwarded-for": ip }))).status).toBe(200);
    expect(spy.calls).toEqual([]);
    // A miss of the limited address is still refused; another address is not.
    expect((await handler(deps(), get(url, { "x-forwarded-for": ip }))).status).toBe(429);
    expect((await handler(deps(), get(url, { "x-forwarded-for": freshIp() }))).status).toBe(200);
  });

  it("also counts misses per IPv6 /48 (play:img:net), so many /64 networks of one site share a budget; another site is not affected", async () => {
    const limits = { perIp: 5, perNet: 8, windowMs: 60_000 };
    const handler = ownedImageHandler("set", createImageCache(), limits);
    const site = randomInt(1, 0xffff).toString(16);
    const ipIn = (network: number): string => `2001:db8:${site}:${network.toString(16)}::1`;
    const miss = (ip: string) => handler(deps(), get(setImageUrl(randomUUID(), randomUUID()), { "x-forwarded-for": ip }));
    // Eight different /64 networks of one /48, one miss each: every /64 is far under its own 5, the site is at its 8.
    for (let network = 1; network <= 8; network++) expect((await miss(ipIn(network))).status, `network ${String(network)}`).toBe(404);
    const refused = await miss(ipIn(9));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Another site (another /48) is its own budget, and one /64 alone is limited at its own 5.
    const other = randomInt(1, 0xffff).toString(16);
    for (let i = 0; i < 5; i++) expect((await miss(`2001:db8:${other}:1::1`)).status).toBe(404);
    expect((await miss(`2001:db8:${other}:1::1`)).status).toBe(429);
    expect((await miss(`2001:db8:${other}:2::1`)).status).toBe(404);
    // The defaults: 300 a /64 a minute, ten times that a /48.
    expect(IMAGE_MISS_LIMIT).toEqual({ perIp: 300, perNet: 3000, windowMs: 60_000 });
  });

  it("fails open when Valkey is down (the answer is public and cached, the lookup is one indexed query), and says so in the log", async () => {
    const lines = captureLog();
    const response = await setHandler()(deps({ valkey: brokenValkey, log: lines.log }), get(setImageUrl(content.setId, content.thumbnail.id)));
    expect(response.status).toBe(200);
    expect(lines.lines.join("\n")).toContain("valkey_unavailable");
    // Not a hole: the owning-row check still applies without Valkey.
    await expectBare404(await setHandler()(deps({ valkey: brokenValkey }), get(setImageUrl(content.setId, randomUUID()))));
  });

  it("answers 503 (not a 404 that hides it) when the database fails, with nothing of the error in the log", async () => {
    const lines = captureLog();
    const closed = createPublicSql(inject("publicDbUrl"), 1);
    await closed.end();
    const response = await setHandler()(deps({ sql: closed, log: lines.log }), get(setImageUrl(content.setId, content.thumbnail.id)));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(lines.lines.join("\n")).not.toContain(content.setId);
    expect(lines.lines.join("\n")).not.toContain(dataDir);
  });
});

describe("what public_rw may read of uploads", () => {
  it("is only the columns the route needs (id, kind, storage_path, content_type): not the file name, size, digest or the uploader", async () => {
    expect(await publicSql`SELECT id, kind, storage_path, content_type FROM public.uploads LIMIT 1`).toBeDefined();
    for (const column of ["original_filename", "size_bytes", "sha256", "created_by_admin_user_id", "created_at", "superseded_at"]) {
      await expect(publicSql.unsafe(`SELECT ${column} FROM public.uploads LIMIT 1`), column).rejects.toMatchObject({ code: "42501" });
    }
    await expect(publicSql`SELECT * FROM public.uploads LIMIT 1`).rejects.toMatchObject({ code: "42501" });
  });
});
