import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { OUT_DIR, loadPrompts } from "./common.ts";
import type { ManifestEntry } from "./optimize.ts";

const manifest = JSON.parse(readFileSync(path.join(OUT_DIR, "manifest.json"), "utf8")) as ManifestEntry[];
const { assets } = loadPrompts();
const overlays = new Set(assets.filter((a) => a.transparent === true).map((a) => a.id));

describe("asset manifest", () => {
  it("covers every prompt at 1x/2x in avif and webp", () => {
    expect(manifest).toHaveLength(assets.length * 4);
    for (const a of assets) {
      const variants = manifest
        .filter((e) => e.id === a.id)
        .map((e) => `${e.format}@${String(e.scale)}`)
        .sort();
      expect(variants).toEqual(["avif@1", "avif@2", "webp@1", "webp@2"]);
    }
  });

  it.each(manifest.map((e) => [e.file, e] as const))("%s matches its manifest entry", async (_file, entry) => {
    const buf = readFileSync(path.join(OUT_DIR, entry.file));
    expect(createHash("sha256").update(buf).digest("hex")).toBe(entry.sha256);
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(entry.width);
    expect(meta.height).toBe(entry.height);
    expect(meta.format).toBe(entry.format === "avif" ? "heif" : "webp");
    if (entry.scale === 1) {
      const twice = manifest.find((e) => e.id === entry.id && e.format === entry.format && e.scale === 2);
      expect(Math.abs((twice?.width ?? 0) - entry.width * 2)).toBeLessThanOrEqual(1);
    }
    if (overlays.has(entry.id)) {
      expect(meta.hasAlpha).toBe(true);
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      let transparent = 0;
      for (let i = info.channels - 1; i < data.length; i += info.channels) {
        if ((data[i] ?? 255) < 10) transparent++;
      }
      expect(transparent / (data.length / info.channels)).toBeGreaterThan(0.05);
    }
  });
});
