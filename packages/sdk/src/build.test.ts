// The build (scripts/build.ts): the immutable file, the alias, the self-hosted Cap widget, the size
// budget, and static guards on what the bundle and the sources may contain.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSdk, type SdkBuild } from "../scripts/build.ts";

/** AC: under 15 KB gzipped. Decimal kilobytes (15 000 bytes), the stricter reading. */
const GZIP_BUDGET_BYTES = 15_000;

const SRC = dirname(fileURLToPath(import.meta.url));
let outDir = "";
let built: SdkBuild;
const read = (name: string): Buffer => readFileSync(join(outDir, name));
const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "ebt-sdk-build-"));
  built = await buildSdk(outDir);
});
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("build output", () => {
  it("is an immutable sdk-v1.x.y.js named after the package version, the v1.js alias, the Cap widget and its two WebAssembly solvers", () => {
    const { version } = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as { version: string };
    expect(version).toMatch(/^1\.\d+\.\d+$/);
    expect(built.sdkFile).toBe(`sdk-v${version}.js`);
    expect(built.aliasFile).toBe("v1.js");
    expect(readdirSync(outDir).sort()).toEqual([built.capFile, built.hashwxFile, built.sdkFile, built.wasmFile, "v1.js"].sort());
  });

  it("makes the alias a byte-for-byte copy of the immutable file", () => {
    expect(sha256(read("v1.js"))).toBe(sha256(read(built.sdkFile)));
  });

  it("is deterministic", async () => {
    const again = mkdtempSync(join(tmpdir(), "ebt-sdk-build-"));
    try {
      await buildSdk(again);
      expect(sha256(readFileSync(join(again, built.sdkFile)))).toBe(sha256(read(built.sdkFile)));
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  });

  it("self-hosts the Cap widget unmodified, named after the installed @cap.js/widget version", () => {
    const widgetManifest = createRequire(import.meta.url).resolve("@cap.js/widget/package.json");
    const widget = JSON.parse(readFileSync(widgetManifest, "utf8")) as { version: string };
    expect(widget.version).toBe("0.1.62");
    expect(built.capFile).toBe(`cap-v${widget.version}.js`);
    expect(sha256(read(built.capFile))).toBe(sha256(readFileSync(join(dirname(widgetManifest), "cap.min.js"))));
    expect(read(built.sdkFile).toString("utf8")).toContain(built.capFile);
  });

  it("self-hosts the widget's WebAssembly solvers unmodified (owner decision O1), at the version the widget asks for", () => {
    const wasmManifest = createRequire(import.meta.url).resolve("@cap.js/wasm/package.json");
    const wasm = JSON.parse(readFileSync(wasmManifest, "utf8")) as { version: string };
    const widgetManifest = createRequire(import.meta.url).resolve("@cap.js/widget/package.json");
    expect(wasm.version).toBe("0.0.8");
    expect(built.wasmFile).toBe(`cap-wasm-v${wasm.version}.wasm`);
    expect(built.hashwxFile).toBe(`cap-hashwx-v${wasm.version}.wasm`);
    expect(sha256(read(built.wasmFile))).toBe(sha256(readFileSync(join(dirname(wasmManifest), "browser", "cap_wasm_bg.wasm"))));
    expect(sha256(read(built.hashwxFile))).toBe(sha256(readFileSync(join(dirname(wasmManifest), "browser", "hashwx.wasm"))));
    // The widget fetches `@cap.js/wasm@<WASM_VERSION>` by default: ours must be that version.
    const widgetSource = readFileSync(join(dirname(widgetManifest), "cap.min.js"), "utf8");
    expect(widgetSource).toContain('"' + wasm.version + '"');
    expect(widgetSource).toContain("@cap.js/wasm@");
    for (const file of [built.wasmFile, built.hashwxFile]) expect(read(file).subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    const bundle = read(built.sdkFile).toString("utf8");
    expect(bundle).toContain(built.wasmFile);
    expect(bundle).toContain(built.hashwxFile);
  });
});

describe("size budget", () => {
  it(`is under ${String(GZIP_BUDGET_BYTES)} bytes gzipped`, () => {
    const gzipped = gzipSync(read(built.sdkFile), { level: 9 }).length;
    expect(gzipped).toBeLessThan(GZIP_BUDGET_BYTES);
  });

  it("keeps the Cap widget and the rest of the i18n catalog out of the bundle", () => {
    const bundle = read(built.sdkFile).toString("utf8");
    expect(bundle).not.toContain("cap-widget");
    expect(bundle).not.toContain("Papan Peringkat");
    expect(bundle).not.toContain("Mockup");
    expect(bundle).not.toContain("zod");
    expect(bundle).toContain("Memproses pesanan");
  });
});

describe("what the bundle must never do", () => {
  const bundle = (): string => read(built.sdkFile).toString("utf8");

  it("contains no eval, Function constructor, document.write or HTML-string sinks", () => {
    for (const forbidden of [/\beval\s*\(/, /new\s+Function\b/, /\bFunction\s*\(/, /document\s*\.\s*write/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /\bimportScripts\b/, /setTimeout\(\s*["'`]/, /setInterval\(\s*["'`]/, /\.srcdoc\b/]) {
      expect(bundle(), String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("contacts no third party except the three pixel vendors' own script hosts", () => {
    const urls = [...bundle().matchAll(/https?:\/\/[^\s"'`\\)]+/g)].map((m) => new URL(m[0]).host);
    expect([...new Set(urls)].sort()).toEqual(["analytics.tiktok.com", "connect.facebook.net", "www.googletagmanager.com"]);
  });

  it("writes to storage only from attribution.ts and pixels.ts, names sessionStorage only where it is handed over and used, and never writes cookies", () => {
    const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const writers = sources.filter((f) => /\.setItem\(/.test(readFileSync(join(SRC, f), "utf8")));
    expect(writers.sort()).toEqual(["attribution.ts", "pixels.ts"]);
    for (const file of sources) {
      const code = readFileSync(join(SRC, file), "utf8");
      expect(code, file).not.toMatch(/indexedDB|document\s*\.\s*cookie\s*=[^=]/);
      if (!["attribution.ts", "index.ts"].includes(file)) expect(code, file).not.toMatch(/sessionStorage/);
    }
  });
});
