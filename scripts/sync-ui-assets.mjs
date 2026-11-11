// Copies packages/ui/assets (AVIF/WebP) into an app's public/assets so Next serves them.
// Usage: node ../../scripts/sync-ui-assets.mjs   (run from an app directory)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../packages/ui/assets");
const target = resolve(process.cwd(), "public/assets");

if (!existsSync(source)) {
  throw new Error(`assets source missing: ${source}`);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    cpSync(join(source, entry.name), join(target, entry.name), { recursive: true });
  }
}
console.log(`synced ui assets -> ${target}`);
