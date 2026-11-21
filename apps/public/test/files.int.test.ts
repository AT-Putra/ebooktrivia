// US-025: the signed ebook download (lib/files.ts) against a real Valkey (ACL user `public`) and a PDF on disk. WAHA fetches the URL the worker
// signs (10 minutes), the e-mail fallback holds one for 72 hours; nothing else is ever served.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signFileUrl } from "@ebooktrivia/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWahaMockApp } from "../../../infra/waha-mock/src/app.ts";
import { FILE_URL_CAP, type FilesDeps, handleFileDownload, urlKey } from "../src/lib/files.ts";
import { captureLog, DOMAIN, freshIp, newValkey, valkey } from "./support.ts";

/** A different expiry for every URL a test signs (the limit is per signed URL, i.e. per path, expiry and nonce: the nonce alone already separates them): a TTL of 1..599 s on top of the base. */
let counter = Math.floor(Math.random() * 598);
const unique = (): number => 1 + (counter++ % 598);

const KEY = randomBytes(32);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(4096), Buffer.from("\n%%EOF\n")]);
const uploadId = randomUUID();
const STORAGE = `deliverables/${uploadId}.pdf`;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-files-"));
  await mkdir(join(dataDir, "deliverables"), { recursive: true });
  await writeFile(join(dataDir, STORAGE), PDF);
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function deps(overrides: Partial<FilesDeps> = {}): FilesDeps & { readonly lines: string[] } {
  const logs = captureLog();
  return { valkey, domain: DOMAIN, dataDir, key: KEY, log: logs.log, lines: logs.lines, ...overrides };
}

const signed = (path = `/files/${STORAGE}`, options: { ttlSeconds?: number; now?: Date; key?: Uint8Array } = {}): string =>
  signFileUrl({ origin: `https://api.${DOMAIN}`, path, key: options.key ?? KEY, now: options.now ?? new Date(), ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }) });

const get = (d: FilesDeps, url: string, headers: Record<string, string> = {}): Promise<Response> => {
  const parsed = new URL(url);
  return handleFileDownload(d, new Request(url, { headers: { host: parsed.host, "x-forwarded-for": freshIp(), ...headers } }));
};

describe("the signed ebook download", () => {
  it("serves the PDF to a valid signed URL, as an attachment that is never rendered on our origin", async () => {
    const d = deps();
    const res = await get(d, signed());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe(String(PDF.length));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ebook.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    // The URL is multi-use until it expires (WAHA may retry the download).
    const url = signed();
    expect((await get(d, url)).status).toBe(200);
    expect((await get(d, url)).status).toBe(200);
    // The query (the signature) never reaches a log line.
    expect(d.lines.join("\n")).not.toContain("sig=");
    expect(d.lines.join("\n")).not.toContain(uploadId);
  });

  it("refuses a forged, tampered, expired or missing signature with one answer (403), and serves nothing", async () => {
    const d = deps();
    const url = signed();
    const parsed = new URL(url);
    const variants: Record<string, string> = {
      "no query": `https://api.${DOMAIN}/files/${STORAGE}`,
      "no signature": `${parsed.origin}${parsed.pathname}?exp=${parsed.searchParams.get("exp") ?? ""}`,
      "another key": signed(undefined, { key: randomBytes(32) }),
      "expired": signed(undefined, { now: new Date(Date.now() - 3_600_000) }),
      "a later expiry": url.replace(/exp=\d+/, `exp=${String(Number(parsed.searchParams.get("exp")) + 3600)}`),
      "a signature of another path": signed(`/files/deliverables/${randomUUID()}.pdf`).replace(/\/files\/deliverables\/[0-9a-f-]+\.pdf/, `/files/${STORAGE}`),
      "a malformed signature": url.replace(/sig=[^&]+/, "sig=AAAA"),
      "no nonce": url.replace(/&n=[^&]+/, ""),
      "another nonce": url.replace(/&n=[^&]+/, `&n=${randomBytes(16).toString("base64url")}`),
    };
    for (const [name, variant] of Object.entries(variants)) {
      const res = await get(d, variant);
      expect(res.status, name).toBe(403);
      expect(res.body, name).toBeNull();
    }
    expect(d.lines.some((l) => l.includes('"reason":"expired"'))).toBe(true);
  });

  it("serves only the deliverable paths, only on the api origin, and nothing outside the data directory", async () => {
    const d = deps();
    // Not a deliverable path (the signature would verify): 404.
    for (const path of ["/files/other/x.pdf", "/files/deliverables/notauuid.pdf", `/files/deliverables/${uploadId}.png`, "/files/deliverables/../../etc/passwd", `/files/deliverables/${uploadId}.pdf/extra`]) {
      const res = await get(d, `https://api.${DOMAIN}${path}?exp=9999999999&sig=${"A".repeat(43)}`);
      expect(res.status, path).toBe(404);
    }
    // Other origins: the route does not exist there.
    for (const host of [`play.${DOMAIN}`, `order.${DOMAIN}`, "evil.example.test", DOMAIN]) {
      const url = signed().replace(`api.${DOMAIN}`, host);
      expect((await get(d, url)).status, host).toBe(404);
    }
    // A signed deliverable that is not on disk: 404.
    expect((await get(d, signed(`/files/deliverables/${randomUUID()}.pdf`))).status).toBe(404);
  });

  it("is closed (503) without the key", async () => {
    expect((await get(deps({ key: undefined }), signed())).status).toBe(503);
  });

  it("limits each signed URL (not each client IP): one address may fetch many URLs, one URL is worth FILE_URL_CAP downloads, forged ones count for nothing", async () => {
    const d = deps();
    const ip = freshIp();
    const url = signed(undefined, { ttlSeconds: unique() });
    for (let i = 0; i < FILE_URL_CAP; i++) expect((await get(d, url, { "x-forwarded-for": ip })).status, `download ${String(i + 1)}`).toBe(200);
    const limited = await get(d, url, { "x-forwarded-for": ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // A leaked link is capped from anywhere; another URL from the same address is not affected (WAHA fetches one per delivery).
    expect((await get(d, url)).status).toBe(429);
    for (let i = 0; i < FILE_URL_CAP + 5; i++) expect((await get(d, signed(undefined, { ttlSeconds: unique() }), { "x-forwarded-for": ip })).status).toBe(200);
    // Forged URLs are refused before they count.
    expect((await get(d, url.replace(/sig=[^&]+/, `sig=${"B".repeat(43)}`), { "x-forwarded-for": ip })).status).toBe(403);
    // The counter lives as long as the URL: its key expires with it (never a counter without a TTL). The exact key of THIS url is read, not scanned for: on a shared
    // Valkey a single SCAN page may not hold it.
    const inspect = await newValkey(undefined, true);
    const parsed = new URL(url);
    const key = `rl:files:url:${urlKey(parsed.pathname, parsed.searchParams.get("exp") ?? "", parsed.searchParams.get("n") ?? "")}`;
    expect(await inspect.exists(key)).toBe(1);
    const ttl = await inspect.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    // ... and no longer than the URL itself has left (ttlSeconds is below 600).
    expect(ttl).toBeLessThanOrEqual(600_000);
  });

  it("LOW-2: URLs of the same file with the SAME expiry (a pre-flight check and WAHA's link minted in the same second) never share a download counter, and the nonce cannot be swapped", async () => {
    const d = deps();
    const now = new Date();
    const a = signed(undefined, { ttlSeconds: 600, now });
    const b = signed(undefined, { ttlSeconds: 600, now });
    const parsedA = new URL(a);
    const parsedB = new URL(b);
    expect(parsedA.searchParams.get("exp")).toBe(parsedB.searchParams.get("exp"));
    expect(parsedA.searchParams.get("n")).not.toBe(parsedB.searchParams.get("n"));
    // `a` is used up; `b` still has its full allowance.
    for (let i = 0; i < FILE_URL_CAP; i++) expect((await get(d, a)).status, `download ${String(i + 1)}`).toBe(200);
    expect((await get(d, a)).status).toBe(429);
    expect((await get(d, b)).status).toBe(200);
    // Swapping in the nonce of another URL (or dropping it) to reach a fresh counter fails the signature: one answer, nothing served, nothing counted.
    parsedA.searchParams.set("n", parsedB.searchParams.get("n") ?? "");
    expect((await get(d, parsedA.href)).status).toBe(403);
    parsedA.searchParams.delete("n");
    expect((await get(d, parsedA.href)).status).toBe(403);
  });

  it("with Valkey down: a short-lived URL (WAHA's) is still served, the 72 h e-mail link fails closed", async () => {
    const down = deps({ valkey: await newValkey(1) });
    const short = await get(down, signed(undefined, { ttlSeconds: unique() }));
    expect(short.status).toBe(200);
    expect(Buffer.from(await short.arrayBuffer()).equals(PDF)).toBe(true);
    expect(down.lines.some((l) => l.includes('"reason":"valkey_unavailable_short_url"'))).toBe(true);
    const long = await get(down, signed(undefined, { ttlSeconds: 72 * 3600 - unique() }));
    expect(long.status).toBe(503);
    // Ten minutes is the line: 601 seconds left is already a long URL.
    expect((await get(down, signed(undefined, { ttlSeconds: 601 }))).status).toBe(503);
    expect((await get(down, signed(undefined, { ttlSeconds: 600 }))).status).toBe(200);
  });

  // This test is about the ROUTE (one counter per signed URL, forged URLs refused), driven by a downloader that fetches the URL the way WAHA does. `fetchFiles: true` is the
  // waha-mock's STRICT mode: a download that fails refuses the send with 422. The Owner's WEBJS does NOT do that (R11, docs/spikes/R11.md: it sends the error page as the
  // document and answers 201), so the 422s below are the strict mock's answer to a refused download, NOT what a real send does. What keeps a refusing or broken route from
  // reaching a buyer is the worker's pre-flight before every file send and its read-back after it: apps/worker/test/delivery-file-check.int.test.ts.
  it("serves a WAHA-like downloader (the waha-mock's strict fetch mode): every delivery of a burst from one address is served, one URL is worth FILE_URL_CAP downloads", async () => {
    const d = deps();
    const mock = createWahaMockApp({
      apiKey: "k",
      webhookHmacSecret: "s",
      fetchFiles: true,
      fetchImpl: (input, init) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return handleFileDownload(d, new Request(href, { method: "GET", headers: { host: new URL(href).host, "x-forwarded-for": "198.51.100.7", ...(init?.headers as Record<string, string> | undefined) } }));
      },
    });
    const send = async (url: string): Promise<Response> =>
      await mock.request("/api/sendFile", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body: JSON.stringify({ session: "default", chatId: "6281234567890@c.us", file: { url, filename: "ebook.pdf", mimetype: "application/pdf" } }) });
    // A burst of 40 deliveries: each with its own URL (the worker signs one per send), all from WAHA's one address: all go through. (The old
    // per-IP limit of 60 per 10 minutes would have stopped the burst of a busy minute.)
    const statuses = await Promise.all(Array.from({ length: 40 }, () => send(signed(undefined, { ttlSeconds: unique() })).then((r) => r.status)));
    // (A successful WEBJS send answers 201, as recorded in US-005.)
    expect(statuses.every((s) => s === 201)).toBe(true);
    // A downloader retrying one URL more than FILE_URL_CAP times is refused by the route (429), which the STRICT mock turns into a refused send (422).
    const one = signed(undefined, { ttlSeconds: unique() });
    const retried: number[] = [];
    for (let i = 0; i < FILE_URL_CAP + 2; i++) retried.push((await send(one)).status);
    expect(retried.slice(0, FILE_URL_CAP).every((s) => s === 201)).toBe(true);
    expect(retried.slice(FILE_URL_CAP)).toEqual([422, 422]);
    // A forged URL is refused by the route (403): a refused send in the strict mock.
    expect((await send(signed(undefined, { key: randomBytes(32) }))).status).toBe(422);
  });
});
