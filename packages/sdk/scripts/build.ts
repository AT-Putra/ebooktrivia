// Builds the landing-page SDK (US-019, M6a) into `dist/`:
//
//   sdk-v<version>.js   the SDK, an immutable file named after packages/sdk/package.json's version
//                       (served with a one-year `immutable` cache); bump the version for every change
//   v1.js               the alias the snippet uses, a byte-for-byte copy of the newest v1 file (served
//                       with a 5 minute cache so a new release reaches pages within minutes)
//   cap-v<version>.js   the Cap widget (@cap.js/widget), self-hosted and loaded lazily by the SDK;
//                       an unmodified copy of the package's cap.min.js, named after its version
//   cap-wasm-v<version>.wasm, cap-hashwx-v<version>.wasm
//                       the widget's WebAssembly solvers (@cap.js/wasm, browser/cap_wasm_bg.wasm and
//                       browser/hashwx.wasm), unmodified and named after the package version. The
//                       widget fetches them from a public CDN unless told where they are; the SDK
//                       tells it. They are outside the SDK's size budget (loaded on demand)
//
// esbuild 0.28.2: one minified IIFE for ES2020 browsers, no eval, no dynamic code, no source maps.
//   node scripts/build.ts [outDir]
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SdkBuild {
  readonly outDir: string;
  readonly version: string;
  readonly sdkFile: string;
  readonly aliasFile: string;
  readonly capFile: string;
  readonly capVersion: string;
  readonly wasmFile: string;
  readonly hashwxFile: string;
  readonly wasmVersion: string;
}

const readVersion = (file: string): string => {
  const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
  if (typeof version !== "string") throw new Error(`${file} has no version`);
  return version;
};

export async function buildSdk(outDir: string = join(root, "dist")): Promise<SdkBuild> {
  const version = readVersion(join(root, "package.json"));
  const major = /^([1-9][0-9]*)\.[0-9]+\.[0-9]+$/.exec(version)?.[1];
  if (major === undefined) throw new Error(`packages/sdk version ${version} must be MAJOR.MINOR.PATCH`);

  const widgetManifest = createRequire(import.meta.url).resolve("@cap.js/widget/package.json");
  const capVersion = readVersion(widgetManifest);
  const capFile = `cap-v${capVersion}.js`;

  const wasmManifest = createRequire(import.meta.url).resolve("@cap.js/wasm/package.json");
  const wasmVersion = readVersion(wasmManifest);
  // The widget asks for the wasm version it was built against (WASM_VERSION in its source).
  const widgetSource = readFileSync(join(dirname(widgetManifest), "cap.min.js"), "utf8");
  if (!widgetSource.includes(`"${wasmVersion}"`)) throw new Error(`@cap.js/widget ${capVersion} does not use @cap.js/wasm ${wasmVersion}: pin the matching version`);
  const wasmFile = `cap-wasm-v${wasmVersion}.wasm`;
  const hashwxFile = `cap-hashwx-v${wasmVersion}.wasm`;

  const result = await build({
    entryPoints: [join(root, "src", "index.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2020",
    platform: "browser",
    minify: true,
    legalComments: "none",
    define: { __CAP_FILE__: JSON.stringify(capFile), __CAP_WASM_FILE__: JSON.stringify(wasmFile), __CAP_HASHWX_FILE__: JSON.stringify(hashwxFile) },
    logLevel: "silent",
  });
  // A warning is a bug here (a JSON key that is not exported, an unresolved import): fail the build.
  if (result.warnings.length > 0) throw new Error(`esbuild warnings: ${result.warnings.map((w) => w.text).join("; ")}`);
  const output = result.outputFiles[0];
  if (result.outputFiles.length !== 1 || output === undefined) throw new Error("esbuild produced no single output");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const sdkFile = `sdk-v${version}.js`;
  const aliasFile = `v${major}.js`;
  writeFileSync(join(outDir, sdkFile), output.contents);
  copyFileSync(join(outDir, sdkFile), join(outDir, aliasFile));
  copyFileSync(join(dirname(widgetManifest), "cap.min.js"), join(outDir, capFile));
  copyFileSync(join(dirname(wasmManifest), "browser", "cap_wasm_bg.wasm"), join(outDir, wasmFile));
  copyFileSync(join(dirname(wasmManifest), "browser", "hashwx.wasm"), join(outDir, hashwxFile));
  return { outDir, version, sdkFile, aliasFile, capFile, capVersion, wasmFile, hashwxFile, wasmVersion };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const built = await buildSdk(process.argv[2] === undefined ? undefined : resolve(process.argv[2]));
  console.log(`built ${built.sdkFile}, ${built.aliasFile}, ${built.capFile}, ${built.wasmFile}, ${built.hashwxFile} in ${built.outDir}`);
}
