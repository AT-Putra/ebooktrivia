// Minimal reader for the systemd-style unit files in infra/quadlet (sections, repeated keys,
// comments). Enough for the consistency tests; the quadlet generator itself is run by
// infra/verify/local/vm-sim.sh (dryrun).
import { readdirSync, readFileSync } from "node:fs";

export const QUADLET_DIR = new URL("../../quadlet/", import.meta.url);

export interface Quadlet {
  readonly name: string;
  /** Every value of `key` in `section`, in order (a repeated key adds values). */
  get(section: string, key: string): string[];
  /** Environment= assignments of [Container], merged. */
  environment(): Record<string, string>;
}

export function parseQuadlet(name: string, text: string): Quadlet {
  const entries: { section: string; key: string; value: string }[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) throw new Error(`${name}: not a key=value line: ${line}`);
    entries.push({ section, key: line.slice(0, eq), value: line.slice(eq + 1) });
  }
  const get = (s: string, k: string) => entries.filter((e) => e.section === s && e.key === k).map((e) => e.value);
  return {
    name,
    get,
    environment: () =>
      Object.fromEntries(
        get("Container", "Environment")
          .flatMap((v) => v.split(/\s+/))
          .filter((v) => v !== "")
          .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
      ),
  };
}

export function readQuadlet(file: string): Quadlet {
  return parseQuadlet(file, readFileSync(new URL(file, QUADLET_DIR), "utf8"));
}

export function quadletFiles(): string[] {
  return readdirSync(QUADLET_DIR).filter((f) => /\.(container|network|volume|socket)$/.test(f));
}
