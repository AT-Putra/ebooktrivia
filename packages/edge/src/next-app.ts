// Runs a Next.js standalone build (`output: "standalone"`) behind the edge listener. The app's
// src/server.ts passes Next's own `next()` factory, so this package does not depend on Next.
//
// The build's serialized config (.next/required-server-files.json) is handed to Next the way its
// generated standalone server.js does it (__NEXT_PRIVATE_STANDALONE_CONFIG), so next.config.ts is
// never loaded at runtime. Next listens nowhere itself: only the edge listener does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, loadEdgeConfig } from "./config.ts";
import { type AppHandler, type RunningEdge, startEdgeServer } from "./edge-server.ts";
import { drainOnSignals, type SignalProcess } from "./signals.ts";

export interface NextLike {
  prepare(): Promise<void>;
  getRequestHandler(): AppHandler;
}

export type NextFactory = (options: { dev: false; dir: string; hostname: string; port: number; conf: Record<string, unknown> }) => NextLike;

export function readStandaloneConfig(dir: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(dir, ".next", "required-server-files.json"), "utf8")) as { config?: unknown };
  if (typeof manifest.config !== "object" || manifest.config === null) throw new Error(".next/required-server-files.json has no config");
  return manifest.config as Record<string, unknown>;
}

export async function startNextBehindEdge(
  dir: string,
  env: Env,
  next: NextFactory,
  log: (message: string) => void,
  proc: SignalProcess = process,
): Promise<RunningEdge> {
  const config = loadEdgeConfig(env);
  if (!config.production) throw new Error("the standalone server runs with NODE_ENV=production only");
  const conf = readStandaloneConfig(dir);
  process.env["__NEXT_PRIVATE_STANDALONE_CONFIG"] = JSON.stringify(conf);
  const app = next({ dev: false, dir, hostname: config.host, port: config.port, conf });
  await app.prepare();
  const handle = app.getRequestHandler();
  const edge = await startEdgeServer({ ...config, handle, log });
  drainOnSignals(() => edge.drain(), log, proc);
  log(`listening on ${config.host}:${String(edge.port)} (trusted proxy ${config.trustedProxy ?? "none"})`);
  return edge;
}
