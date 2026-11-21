// Copies the Cap widget and its WebAssembly solvers into apps/public/public/cap/ so the play login page
// (US-026) serves them from its own origin, exactly as the landing-page SDK self-hosts them next to itself
// (packages/sdk/scripts/build.ts): unmodified files of the pinned @cap.js/widget and @cap.js/wasm, which the
// SDK package depends on. Without them the widget would fetch its solvers from a public CDN.
// Usage: node apps/public/scripts/sync-cap-assets.mjs   (from any directory; part of `sync-assets`)
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fromSdk = createRequire(resolve(here, "../../../packages/sdk/package.json"));
const widgetDir = dirname(fromSdk.resolve("@cap.js/widget/package.json"));
const wasmManifest = fromSdk.resolve("@cap.js/wasm/package.json");
const wasmVersion = JSON.parse(readFileSync(wasmManifest, "utf8")).version;
const widget = join(widgetDir, "cap.min.js");
// The widget asks for the wasm version it was built against (as the SDK build checks).
if (!readFileSync(widget, "utf8").includes(`"${wasmVersion}"`)) throw new Error(`@cap.js/widget does not use @cap.js/wasm ${wasmVersion}: pin the matching version`);

const target = resolve(here, "../public/cap");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
copyFileSync(widget, join(target, "cap.js"));
copyFileSync(join(dirname(wasmManifest), "browser", "cap_wasm_bg.wasm"), join(target, "cap-wasm.wasm"));
copyFileSync(join(dirname(wasmManifest), "browser", "hashwx.wasm"), join(target, "cap-hashwx.wasm"));
console.log(`synced Cap widget -> ${target}`);
