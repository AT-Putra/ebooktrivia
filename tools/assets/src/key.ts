import { execFileSync } from "node:child_process";

const KEY_NAME = "9router";

/**
 * Reads the 9router API key. Env var names starting with a digit are not
 * inherited by Node under Git Bash, so on Windows fall back to the registry.
 * The returned value must never be logged, written, or put in error messages.
 */
export function readApiKey(): string | undefined {
  const fromEnv = process.env[KEY_NAME];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", KEY_NAME], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out);
    const value = match?.[1]?.trim();
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
