import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RAW_DIR, loadPrompts, type AssetPrompt, type RawMeta } from "./common.ts";
import { readApiKey } from "./key.ts";

const ENDPOINT = "http://localhost:20128/v1/images/generations";
const CONCURRENCY = 2;
const MAX_RETRIES = 2;
const TIMEOUT_MS = 240_000;

interface ImageResponse {
  data?: { b64_json?: string }[];
}

async function requestImage(apiKey: string, model: string, asset: AssetPrompt): Promise<Buffer> {
  const body: Record<string, unknown> = { model, prompt: asset.prompt, n: 1, size: asset.size };
  if (asset.transparent === true) {
    body["background"] = "transparent";
    body["output_format"] = "png";
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
  }
  const b64 = ((await res.json()) as ImageResponse).data?.[0]?.b64_json;
  if (b64 === undefined) throw new Error("response contained no b64_json image");
  return Buffer.from(b64, "base64");
}

async function generateOne(apiKey: string, model: string, asset: AssetPrompt): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const png = await requestImage(apiKey, model, asset);
      const meta: RawMeta = { generatedAt: new Date().toISOString(), model };
      await writeFile(path.join(RAW_DIR, `${asset.stem}.png`), png);
      await writeFile(path.join(RAW_DIR, `${asset.stem}.json`), JSON.stringify(meta));
      console.log(`ok   ${asset.id} (${String(Math.round((Date.now() - started) / 1000))}s)`);
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      if (attempt >= MAX_RETRIES) {
        throw new Error(`${asset.id} failed after ${String(attempt + 1)} attempts: ${reason}`, { cause: err });
      }
      console.warn(`retry ${asset.id} (${String(attempt + 1)}/${String(MAX_RETRIES)}): ${reason}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  const apiKey = readApiKey();
  if (apiKey === undefined) {
    console.error(
      "Missing API key: set the 9router environment variable (on Windows it is read from HKCU\\Environment).",
    );
    process.exit(1);
  }
  const { model, assets } = loadPrompts();
  await mkdir(RAW_DIR, { recursive: true });
  const queue = assets.filter(
    (a) =>
      (only.length === 0 || only.includes(a.id)) && (force || !existsSync(path.join(RAW_DIR, `${a.stem}.png`))),
  );
  console.log(
    `generating ${String(queue.length)} of ${String(assets.length)} assets (concurrency ${String(CONCURRENCY)})`,
  );
  const failures: string[] = [];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await generateOne(apiKey, model, next).catch((err: unknown) => {
        failures.push(err instanceof Error ? err.message : "unknown error");
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}

await main();
