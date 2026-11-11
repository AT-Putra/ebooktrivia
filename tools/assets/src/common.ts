import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RAW_DIR = path.join(TOOL_DIR, "raw");
export const OUT_DIR = path.resolve(TOOL_DIR, "../../packages/ui/assets");

export interface AssetPrompt {
  id: string;
  stem: string;
  size: string;
  transparent?: boolean;
  prompt: string;
}

export interface PromptFile {
  model: string;
  style: string;
  assets: AssetPrompt[];
}

export function loadPrompts(): PromptFile {
  return JSON.parse(readFileSync(path.join(TOOL_DIR, "prompts.json"), "utf8")) as PromptFile;
}

/** Sidecar written next to each raw PNG by generate.ts. */
export interface RawMeta {
  generatedAt: string;
  model: string;
}
