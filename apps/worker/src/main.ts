// Entry point: `node src/main.ts [--role=worker|internal]` (Node runs the TypeScript directly).
// Each role is loaded with a dynamic import, so the internal role's module graph never contains
// the worker's (BullMQ, adapters, consumers) and holds no keys (test/internal.int.test.ts).
import type { Env } from "./env.ts";

export type Role = "worker" | "internal";

export function parseRole(argv: readonly string[]): Role {
  let role: Role | undefined;
  for (const arg of argv) {
    if (!arg.startsWith("--role=")) throw new Error(`unknown argument ${arg}`);
    if (role !== undefined) throw new Error("--role may be given once");
    const value = arg.slice("--role=".length);
    if (value !== "worker" && value !== "internal") throw new Error("--role must be worker or internal");
    role = value;
  }
  return role ?? "worker";
}

export async function main(argv: readonly string[], env: Env): Promise<void> {
  if (parseRole(argv) === "internal") {
    const { runInternal } = await import("./internal.ts");
    await runInternal(env);
  } else {
    const { runWorker } = await import("./worker.ts");
    await runWorker(env);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : "startup failed"}\n`);
    process.exit(1);
  });
}
