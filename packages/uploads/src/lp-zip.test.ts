// US-023 criteria 1 and 3: the LP ZIP checks (zip bomb, traversal, symlink, bad extension and the
// rest of the archive, path and content rules), on archives built in memory (test/zip-fixture.ts).
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type FixtureEntry, makeZip } from "../test/zip-fixture.ts";
import { checkLpZip, LP_FILE_TYPES, LP_ZIP_LIMITS, type LpFile, type LpZipIssueCode, LpZipRejected } from "./lp-zip.ts";

const TAG = '<script src="https://api.example.test/sdk/v1.js" data-lp="lp_abcdefgh12345678" async></script>';
const MiB = 1024 * 1024;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const page = (body = "<p>Hi</p>"): Buffer => Buffer.from(`<!doctype html><html><head><title>LP</title></head><body>${body}</body></html>`);
const index: FixtureEntry = { name: "index.html", data: page() };
const unix = (mode: number): Pick<FixtureEntry, "versionMadeBy" | "externalAttributes"> => ({ versionMadeBy: (3 << 8) | 20, externalAttributes: (mode << 16) >>> 0 });

/** Runs the check with a sink that keeps what it is handed: the site, and the bytes by path. */
async function check(zip: Buffer, limits = LP_ZIP_LIMITS) {
  const written = new Map<string, Buffer>();
  const site = await checkLpZip(zip, { sdkTag: TAG, limits, onFile: (f: LpFile) => Promise.resolve(void written.set(f.path, f.bytes)) });
  return { site, written };
}

async function issues(zip: Buffer, limits = LP_ZIP_LIMITS): Promise<{ code: LpZipIssueCode; entry: string | null; message: string }[]> {
  try {
    await checkLpZip(zip, { sdkTag: TAG, limits, onFile: () => Promise.resolve() });
  } catch (error) {
    if (error instanceof LpZipRejected) return [...error.issues];
    throw error;
  }
  throw new Error("the ZIP was accepted");
}
const codes = async (zip: Buffer, limits = LP_ZIP_LIMITS) => (await issues(zip, limits)).map((i) => i.code);

describe("checkLpZip: a valid landing page", () => {
  it("returns every file with its Content-Type, the SDK tag injected once before </head>, folders parents first", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
    const zip = makeZip([
      index,
      { name: "css/", data: Buffer.alloc(0), method: 0 },
      { name: "css/site.css", data: Buffer.from("body{color:red}") },
      { name: "img/logo.png", data: PNG, method: 0 },
      { name: "img/icons/a.svg", data: svg },
      { name: "promo/index.htm", data: page("<b>promo</b>") },
    ]);
    const { site, written } = await check(zip);
    expect(site.files.map((f) => [f.path, f.contentType])).toEqual([
      ["index.html", "text/html; charset=utf-8"],
      ["css/site.css", "text/css; charset=utf-8"],
      ["img/logo.png", "image/png"],
      ["img/icons/a.svg", "image/svg+xml"],
      ["promo/index.htm", "text/html; charset=utf-8"],
    ]);
    expect(written.get("index.html")?.toString()).toBe(`<!doctype html><html><head><title>LP</title>${TAG}</head><body><p>Hi</p></body></html>`);
    expect(site.directories).toEqual(["css", "img", "promo", "img/icons"]);
    expect(site.injected).toBe(2);
    expect(site.uncompressedBytes).toBe(page().length + "body{color:red}".length + PNG.length + svg.length + page("<b>promo</b>").length);
  });

  it("is idempotent: a page that already holds the exact tag is kept byte for byte", async () => {
    const injected = Buffer.from(`<html><head>${TAG}</head><body></body></html>`);
    const { site, written } = await check(makeZip([{ name: "index.html", data: injected }]));
    expect(written.get("index.html")?.equals(injected)).toBe(true);
    expect(site.injected).toBe(0);
  });

  it("reads a ZIP of one folder from inside that folder", async () => {
    const { site } = await check(makeZip([{ name: "my-site/", data: Buffer.alloc(0), method: 0 }, { name: "my-site/index.html", data: page() }, { name: "my-site/a.js", data: Buffer.from("1") }]));
    expect(site.files.map((f) => f.path)).toEqual(["index.html", "a.js"]);
  });

  it("accepts every allowlisted type with its real content", async () => {
    const samples: Record<string, Buffer> = {
      ".jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      ".jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      ".webp": Buffer.from("RIFF\0\0\0\0WEBPVP8 "),
      ".gif": Buffer.from("GIF89a"),
      ".avif": Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif\0\0\0\0avifmif1miaf")]),
      ".ico": Buffer.from([0, 0, 1, 0, 1, 0]),
      ".woff": Buffer.from("wOFF0000"),
      ".woff2": Buffer.from("wOF20000"),
      ".ttf": Buffer.from([0, 1, 0, 0, 0, 0]),
      ".otf": Buffer.from("OTTO0000"),
      ".mp4": Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom\0\0\0\0isommp42")]),
      ".webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]),
      ".js": Buffer.from("console.log(1)"),
      ".mjs": Buffer.from("export {}"),
      ".json": Buffer.from("{}"),
      ".map": Buffer.from("{}"),
      ".txt": Buffer.from("User-agent: *"),
      ".png": PNG,
    };
    const entries = Object.entries(samples).map(([ext, data]) => ({ name: `f${ext}`, data, method: 0 }));
    const { site } = await check(makeZip([index, ...entries]));
    expect(site.files).toHaveLength(entries.length + 1);
    expect(Object.keys(LP_FILE_TYPES).sort()).toEqual([".avif", ".css", ".gif", ".htm", ".html", ".ico", ".jpeg", ".jpg", ".js", ".json", ".map", ".mjs", ".mp4", ".otf", ".png", ".svg", ".ttf", ".txt", ".webm", ".webp", ".woff", ".woff2"]);
  });
});

describe("checkLpZip: zip bombs and size limits", () => {
  it("stops a zip bomb while inflating: 1 KiB of compressed zeros claiming 1 byte is refused on the ratio budget", async () => {
    const zeros = Buffer.alloc(60 * MiB);
    const bomb = makeZip([index, { name: "bomb.js", data: zeros, declaredSize: 1, crc: 0 }]);
    expect(bomb.length).toBeLessThan(100 * 1024);
    const found = await issues(bomb);
    expect(found.map((i) => i.code)).toEqual(["too_large_uncompressed"]);
  });

  it("refuses more than 150 MiB in total even within the ratio (several files, each under the per-file cap)", async () => {
    const limits = { ...LP_ZIP_LIMITS, maxUncompressedBytes: 2 * MiB, maxFileBytes: MiB, maxRatio: 1_000_000 };
    const noise = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251));
    const zip = makeZip([index, { name: "a.js", data: Buffer.from("a".repeat(MiB - 10)) }, { name: "b.js", data: Buffer.from("b".repeat(MiB - 10)) }, { name: "c.txt", data: noise(1000) }]);
    expect(await codes(zip, limits)).toEqual(["too_large_uncompressed"]);
  });

  it("refuses a file over the per-file cap, naming it", async () => {
    const limits = { ...LP_ZIP_LIMITS, maxFileBytes: 1000 };
    expect(await issues(makeZip([index, { name: "big.js", data: Buffer.from("x".repeat(1001)) }]), limits)).toEqual([
      { code: "file_too_large", entry: "big.js", message: "the file is larger than 0.00095367431640625 MiB uncompressed" },
    ]);
  });

  it("refuses an archive over 25 MiB before parsing it, and more than 500 files", async () => {
    expect(await codes(Buffer.alloc(LP_ZIP_LIMITS.maxZipBytes + 1))).toEqual(["too_large"]);
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `f${String(i)}.txt`, data: Buffer.from("x"), method: 0 }));
    expect(await codes(makeZip([index, ...many]))).toEqual(["too_many_files"]);
    const entries = Array.from({ length: 1001 }, (_, i) => ({ name: `d${String(i)}/`, data: Buffer.alloc(0), method: 0 }));
    expect(await codes(makeZip([index, ...entries]))).toEqual(["too_many_files"]);
  });

  it("refuses a header that lies about the size (the CRC-32 and size are checked after inflating)", async () => {
    expect(await codes(makeZip([index, { name: "a.js", data: Buffer.from("abc"), declaredSize: 2 }]))).toEqual(["invalid_zip"]);
  });
});

describe("checkLpZip: names and paths", () => {
  it("refuses traversal, absolute paths, drive letters, backslashes and NUL (zip.ts), whatever the extension", async () => {
    for (const name of ["../evil.html", "a/../../evil.html", "/etc/passwd.txt", "C:/x.txt", "a\\..\\b.txt", "a\u0000.txt", "./a.txt"]) {
      expect(await codes(makeZip([index, { name, data: Buffer.from("x") }])), JSON.stringify(name)).toEqual(["invalid_zip"]);
    }
  });

  it("refuses hidden, overlong, non-NFC, bidi-spoofed and URL-hostile names", async () => {
    const bad = [".htaccess.txt", "a/.env.txt", `${"a".repeat(129)}.txt`, `${"d/".repeat(16)}a.txt`, "evil\u202egnp.js", "100%.txt", "a?b.txt", "a#b.txt", " lead.txt", "trail.txt ", "a;b.txt", "ends-with-dot."];
    for (const name of bad) expect(await codes(makeZip([index, { name, data: Buffer.from("x") }])), JSON.stringify(name)).toEqual(["unsafe_name"]);
    const { site: ok } = await check(makeZip([index, { name: "Ünïcödé (1) final-v2.txt".normalize("NFC"), data: Buffer.from("x") }]));
    expect(ok.files.map((f) => f.path)).toEqual(["index.html", "Ünïcödé (1) final-v2.txt".normalize("NFC")]);
  });

  it("skips macOS metadata without inflating it, and leaves it out of the top-folder rule and the file count", async () => {
    const bomb = { data: Buffer.alloc(30 * MiB), declaredSize: 1, crc: 0 }; // would fail if inflated
    const zip = makeZip([
      { name: "site/", data: Buffer.alloc(0), method: 0 },
      { name: "site/index.html", data: page() },
      { name: "site/.DS_Store", ...bomb },
      { name: "site/img/._logo.png", ...bomb },
      { name: "__MACOSX/", data: Buffer.alloc(0), method: 0 },
      { name: "__MACOSX/site/._index.html", ...bomb },
    ]);
    // 6 entries: within the entry cap of 2 x 3, and 1 file of 3 allowed (4 if the metadata counted).
    const { site } = await check(zip, { ...LP_ZIP_LIMITS, maxFiles: 3 });
    expect(site.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(site.skipped).toBe(4);
    // They still count against the entry cap of the archive as received.
    expect(await codes(zip, { ...LP_ZIP_LIMITS, maxFiles: 2 })).toEqual(["too_many_files"]);
  });

  it("normalizes NFD names (macOS) to NFC, then refuses two names that are the same after that", async () => {
    const { site } = await check(makeZip([index, { name: "cafe\u0301.txt", data: Buffer.from("x") }]));
    expect(site.files.map((f) => f.path)).toEqual(["index.html", "caf\u00e9.txt"]);
    expect(await codes(makeZip([index, { name: "cafe\u0301.txt", data: Buffer.from("x") }, { name: "CAF\u00c9.txt", data: Buffer.from("y") }]))).toEqual(["duplicate_name"]);
  });

  it("refuses case-colliding names and a name that is both a file and a folder", async () => {
    expect(await codes(makeZip([index, { name: "A.js", data: Buffer.from("1") }, { name: "a.js", data: Buffer.from("2") }]))).toEqual(["invalid_zip"]);
    expect(await codes(makeZip([index, { name: "img", data: Buffer.from("1"), method: 0 }, { name: "img/a.png", data: PNG }]))).toContain("extension_not_allowed");
    expect(await codes(makeZip([index, { name: "x.js", data: Buffer.from("1") }, { name: "x.js/a.png", data: PNG, method: 0 }]))).toEqual(["duplicate_name"]);
    expect(await codes(makeZip([index, { name: "Img/a.png", data: PNG, method: 0 }, { name: "img/b.png", data: PNG, method: 0 }]))).toEqual(["duplicate_name"]);
  });

  it("needs an index.html at the top", async () => {
    expect(await codes(makeZip([{ name: "home.html", data: page() }]))).toEqual(["no_index"]);
    expect(await codes(makeZip([{ name: "Index.html", data: page() }]))).toEqual(["no_index"]);
    expect(await codes(makeZip([{ name: "a/index.html", data: page() }, { name: "b/x.js", data: Buffer.from("1") }]))).toEqual(["no_index"]);
  });
});

describe("checkLpZip: entry types", () => {
  it("refuses a Unix symlink entry, even one named like a page", async () => {
    const link = { name: "evil.html", data: Buffer.from("/etc/passwd"), method: 0, ...unix(0o120777) };
    expect(await issues(makeZip([index, link]))).toEqual([{ code: "symlink", entry: "evil.html", message: "symbolic links are not allowed" }]);
    // OS X host (19) too.
    expect(await codes(makeZip([index, { ...link, versionMadeBy: (19 << 8) | 20 }]))).toEqual(["symlink"]);
  });

  it("refuses devices, FIFOs and sockets, folders posing as files and files posing as folders", async () => {
    for (const mode of [0o020644, 0o060644, 0o010644, 0o140644]) expect(await codes(makeZip([index, { name: "x.txt", data: Buffer.alloc(0), method: 0, ...unix(mode) }]))).toEqual(["not_a_file"]);
    expect(await codes(makeZip([index, { name: "dir.txt", data: Buffer.alloc(0), method: 0, ...unix(0o040755) }]))).toEqual(["not_a_file"]);
    expect(await codes(makeZip([index, { name: "dir.txt", data: Buffer.alloc(0), method: 0, externalAttributes: 0x10 }]))).toEqual(["not_a_file"]);
    expect(await codes(makeZip([index, { name: "d/", data: Buffer.alloc(0), method: 0, ...unix(0o100644) }]))).toEqual(["not_a_file"]);
    expect(await codes(makeZip([index, { name: "d/", data: Buffer.from("payload") }]))).toEqual(["not_a_file"]);
    // A folder entry whose header claims 0 bytes but whose data inflates to more.
    expect(await codes(makeZip([index, { name: "d/", data: Buffer.from("payload"), declaredSize: 0 }]))).toEqual(["not_a_file"]);
    // Regular Unix files and folders are fine.
    await check(makeZip([{ ...index, ...unix(0o100644) }, { name: "d/", data: Buffer.alloc(0), method: 0, ...unix(0o040755) }]));
  });

  it("refuses encrypted entries and compression methods other than stored and deflate", async () => {
    expect((await issues(makeZip([index, { name: "a.js", data: Buffer.from("1"), flags: 0x01 }])))[0]?.message).toContain("encrypted");
    expect((await issues(makeZip([index, { name: "a.js", data: Buffer.from("1"), method: 12, body: Buffer.from("BZh") }])))[0]?.message).toContain("compression method 12");
  });
});

describe("checkLpZip: extensions and contents", () => {
  it("refuses extensions off the allowlist (server code, XML, PDF, executables, no extension), all listed at once", async () => {
    const names = ["shell.php", "a.xml", "b.xhtml", "c.pdf", "d.exe", "e.wasm", "f.shtml", "README", "g.svgz", "h.html.php"];
    const found = await issues(makeZip([index, ...names.map((name) => ({ name, data: Buffer.from("x") }))]));
    expect(found.map((i) => [i.code, i.entry])).toEqual(names.map((n) => ["extension_not_allowed", n]));
  });

  it("refuses content that does not match its extension (sniffed), and binary data in a text file", async () => {
    const cases: [string, Buffer][] = [
      ["fake.png", Buffer.from("<script>alert(1)</script>")],
      ["fake.jpg", PNG],
      ["fake.gif", Buffer.from("GIF00a")],
      ["fake.woff2", Buffer.from("wOFF")],
      ["fake.webm", Buffer.from("....")],
      ["fake.avif", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom\0\0\0\0isommp42")])],
      ["fake.mp4", Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypavif\0\0\0\0avif")])],
      ["bin.js", Buffer.from([0x00, 0x61])],
      ["latin1.css", Buffer.from([0x62, 0xe9, 0x62])],
      ["fake.svg", Buffer.from("<html><script>alert(1)</script></html>")],
      ["png.html", PNG],
    ];
    const found = await issues(makeZip([index, ...cases.map(([name, data]) => ({ name, data, method: 0 }))]));
    expect(found.map((i) => [i.code, i.entry])).toEqual(cases.map(([name]) => ["content_mismatch", name]));
  });

  it("refuses an unsafe SVG and says why", async () => {
    const found = await issues(makeZip([index, { name: "x.svg", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }]));
    expect(found).toEqual([{ code: "svg_unsafe", entry: "x.svg", message: "SVG refused: the element <script>" }]);
  });

  it("refuses HTML without </head>, and HTML that loads the SDK itself", async () => {
    const found = await issues(
      makeZip([
        index,
        { name: "a.html", data: Buffer.from("<p>no head</p>") },
        { name: "b.html", data: Buffer.from('<head><script src="https://api.example.test/sdk/sdk-v1.0.0.js" data-lp="lp_other"></script></head>') },
      ]),
    );
    expect(found.map((i) => [i.code, i.entry])).toEqual([
      ["html_no_head", "a.html"],
      ["html_sdk_tag", "b.html"],
    ]);
  });

  it("counts the original bytes against the budget (deflated text is measured, not trusted)", async () => {
    const js = Buffer.from("x".repeat(5000));
    const zip = makeZip([index, { name: "a.js", data: js, body: deflateRawSync(js) }]);
    const { site } = await check(zip);
    expect(site.uncompressedBytes).toBe(page().length + 5000);
  });
});

describe("checkLpZip: the limits themselves are allowed", () => {
  it("accepts exactly 500 files", async () => {
    const many = Array.from({ length: 499 }, (_, i) => ({ name: `f${String(i)}.txt`, data: Buffer.from("x"), method: 0 }));
    expect((await check(makeZip([index, ...many]))).site.files).toHaveLength(500);
  });

  it("accepts a ZIP of exactly 25 MiB", async () => {
    const without = makeZip([index, { name: "pad.txt", data: Buffer.alloc(0), method: 0 }]).length;
    const zip = makeZip([index, { name: "pad.txt", data: Buffer.alloc(LP_ZIP_LIMITS.maxZipBytes - without, 0x61), method: 0 }]);
    expect(zip.length).toBe(LP_ZIP_LIMITS.maxZipBytes);
    expect((await check(zip)).site.files).toHaveLength(2);
  });

  it("accepts exactly 100:1 (uncompressed bytes = 100 x the ZIP's size)", async () => {
    // zeros.txt deflates to almost nothing; pad.txt is stored, so it adds the same bytes to both sides.
    const build = (zeros: number, pad: number) => makeZip([index, { name: "zeros.txt", data: Buffer.alloc(zeros, 0x30) }, { name: "pad.txt", data: Buffer.alloc(pad, 0x61), method: 0 }]);
    let zip: Buffer | null = null;
    for (let zeros = 1_000_000; zip === null && zeros < 1_000_200; zeros++) {
      const base = build(zeros, 0);
      const excess = index.data.length + zeros - 100 * base.length; // grows by 1 per zero, shrinks by 99 per pad byte
      if (excess >= 0 && excess % 99 === 0) zip = build(zeros, excess / 99);
    }
    if (zip === null) throw new Error("no exact 100:1 archive found");
    const { site } = await check(zip);
    expect(site.uncompressedBytes).toBe(100 * zip.length);
  });

  it("hands each file over as soon as it is checked (never all of them at once)", async () => {
    const zip = makeZip([index, { name: "a.js", data: Buffer.from("1") }, { name: "bomb.js", data: Buffer.alloc(60 * MiB), declaredSize: 1, crc: 0 }]);
    const order: string[] = [];
    const failing = checkLpZip(zip, {
      sdkTag: TAG,
      onFile: (f) => {
        order.push(f.path);
        return f.path === "a.js" ? Promise.reject(new Error("sink stopped")) : Promise.resolve();
      },
    });
    // The sink saw index.html and a.js before the bomb was inflated: its own error wins.
    await expect(failing).rejects.toThrow("sink stopped");
    expect(order).toEqual(["index.html", "a.js"]);
  });
});
