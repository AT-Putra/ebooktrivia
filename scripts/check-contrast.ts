import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Level = "text" | "large" | "nontext";

export interface Pair {
  fg: string;
  bg: string;
  level: Level;
  themes?: string[];
}

export type ThemeTokens = Record<string, Record<string, string>>;

export const MIN_RATIO: Record<Level, number> = { text: 4.5, large: 3, nontext: 3 };
export const DEFAULT_THEME = "trivia";

const BLOCK = /(@theme|\[data-theme="([\w-]+)"\])\s*\{([^{}]*)\}/g;
const COLOR = /--color-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;

/** Parse tokens.css: the @theme block is the "trivia" theme, [data-theme="x"] blocks are themes "x". */
export function parseThemes(css: string): ThemeTokens {
  const themes: ThemeTokens = {};
  for (const block of css.matchAll(BLOCK)) {
    const name = block[2] ?? DEFAULT_THEME;
    const body = block[3] ?? "";
    const tokens = (themes[name] ??= {});
    for (const c of body.matchAll(COLOR)) {
      const key = c[1];
      const value = c[2];
      if (key !== undefined && value !== undefined) tokens[key] = value.toUpperCase();
    }
  }
  return themes;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastResult {
  ok: boolean;
  checked: number;
  problems: string[];
}

export function checkPairs(themes: ThemeTokens, pairs: Pair[]): ContrastResult {
  const problems: string[] = [];
  let checked = 0;
  for (const pair of pairs) {
    const names = pair.themes ?? Object.keys(themes);
    for (const theme of names) {
      const tokens = themes[theme];
      if (tokens === undefined) {
        problems.push(`unknown theme "${theme}" in pair ${pair.fg} on ${pair.bg}`);
        continue;
      }
      const fg = tokens[pair.fg];
      const bg = tokens[pair.bg];
      if (fg === undefined || bg === undefined) {
        const missing = [fg === undefined ? pair.fg : "", bg === undefined ? pair.bg : ""].filter(Boolean);
        problems.push(`[${theme}] missing token(s): ${missing.join(", ")}`);
        continue;
      }
      checked += 1;
      const ratio = contrastRatio(fg, bg);
      const min = MIN_RATIO[pair.level];
      if (ratio < min) {
        problems.push(
          `[${theme}] ${pair.fg} (${fg}) on ${pair.bg} (${bg}) = ${ratio.toFixed(2)}:1, needs ${min}:1 (${pair.level})`,
        );
      }
    }
  }
  return { ok: problems.length === 0, checked, problems };
}

export function checkFiles(tokensPath: string, pairsPath: string): ContrastResult {
  const themes = parseThemes(readFileSync(tokensPath, "utf8"));
  const parsed = JSON.parse(readFileSync(pairsPath, "utf8")) as { pairs: Pair[] };
  return checkPairs(themes, parsed.pairs);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const tokensPath = process.argv[2] ?? "packages/ui/src/tokens.css";
  const pairsPath = process.argv[3] ?? "packages/ui/src/contrast-pairs.json";
  const result = checkFiles(tokensPath, pairsPath);
  if (!result.ok) {
    for (const p of result.problems) console.error(p);
    process.exit(1);
  }
  console.log(`contrast OK: ${result.checked} pair checks`);
}
