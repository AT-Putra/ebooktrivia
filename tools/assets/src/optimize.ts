import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { OUT_DIR, RAW_DIR, loadPrompts, type RawMeta } from "./common.ts";

export interface ManifestEntry {
  id: string;
  file: string;
  format: "avif" | "webp";
  scale: 1 | 2;
  width: number;
  height: number;
  sha256: string;
  promptId: string;
  prompt: string;
  model: string;
  generatedAt: string;
}

async function main(): Promise<void> {
  const { assets } = loadPrompts();
  const entries: ManifestEntry[] = [];
  for (const asset of assets) {
    const raw = await readFile(path.join(RAW_DIR, `${asset.stem}.png`));
    const meta = JSON.parse(await readFile(path.join(RAW_DIR, `${asset.stem}.json`), "utf8")) as RawMeta;
    const { width: rawWidth, height: rawHeight } = await sharp(raw).metadata();
    const dir = path.join(OUT_DIR, asset.stem);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const scale of [1, 2] as const) {
      // 2x keeps the raw size; 1x is half of it.
      const width = Math.round(scale === 2 ? rawWidth : rawWidth / 2);
      const height = Math.round(scale === 2 ? rawHeight : rawHeight / 2);
      const base = sharp(raw).resize(width, height, { fit: "fill" });
      for (const format of ["avif", "webp"] as const) {
        const encoder = format === "avif" ? base.clone().avif({ quality: 60, effort: 3 }) : base.clone().webp({ quality: 82 });
        const buf = await encoder.toBuffer();
        const name = `${asset.stem}@${String(scale)}x.${format}`;
        await writeFile(path.join(dir, name), buf);
        entries.push({
          id: asset.id,
          file: `${asset.stem}/${name}`,
          format,
          scale,
          width,
          height,
          sha256: createHash("sha256").update(buf).digest("hex"),
          promptId: asset.id,
          prompt: asset.prompt,
          model: meta.model,
          generatedAt: meta.generatedAt,
        });
      }
    }
    console.log(`ok   ${asset.id} ${String(rawWidth)}x${String(rawHeight)}`);
  }
  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(entries, null, 2) + "\n");
  console.log(`manifest: ${String(entries.length)} entries`);
}

await main();
