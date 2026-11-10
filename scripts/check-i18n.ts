import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Flatten nested message objects into dotted keys ("leaderboard.title"). */
export function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix === "" ? [] : [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

export interface I18nCheckResult {
  ok: boolean;
  problems: string[];
}

/** Compare two message catalogs; every key must exist in both. */
export function compareCatalogs(
  base: unknown,
  other: unknown,
  baseName: string,
  otherName: string,
): I18nCheckResult {
  const baseKeys = new Set(flattenKeys(base));
  const otherKeys = new Set(flattenKeys(other));
  const problems = [
    ...[...baseKeys].filter((k) => !otherKeys.has(k)).map((k) => `missing in ${otherName}: ${k}`),
    ...[...otherKeys].filter((k) => !baseKeys.has(k)).map((k) => `missing in ${baseName}: ${k}`),
  ];
  return { ok: problems.length === 0, problems };
}

/** Check id.json (buyer locale, source of truth) against en.json in a directory. */
export function checkI18nDir(dir: string): I18nCheckResult {
  const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), "utf8"));
  return compareCatalogs(read("id.json"), read("en.json"), "id.json", "en.json");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const dir = process.argv[2] ?? "packages/i18n/messages";
  const result = checkI18nDir(dir);
  if (!result.ok) {
    for (const p of result.problems) console.error(p);
    process.exit(1);
  }
  console.log(`i18n OK: ${dir}`);
}
