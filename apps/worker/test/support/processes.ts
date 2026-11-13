// Real child processes for the chaos and internal tests: `node <entry>` with an explicit
// environment (only the OS basics are inherited, so a developer's own variables never leak in),
// JSON log lines collected from stdout; `exited` resolves once stdout / stderr are drained too.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

export const WORKER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const MAIN = "src/main.ts";
export const HARNESS = "test/support/worker-harness.ts";
export const RECORD_GRAPH = "test/support/record-graph.ts";

const OS_ENV = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA"];

export interface Child {
  readonly proc: ChildProcess;
  readonly lines: Record<string, unknown>[];
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnNode(args: readonly string[], env: Record<string, string>): Child {
  const base: Record<string, string> = {};
  for (const name of OS_ENV) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  const proc = spawn(process.execPath, [...args], { cwd: WORKER_ROOT, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines: Record<string, unknown>[] = [];
  let stderr = "";
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({ raw: line });
      }
      newline = buffer.indexOf("\n");
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return {
    proc,
    lines,
    stderr: () => stderr,
    exited: new Promise((resolve) => {
      proc.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }),
  };
}

export async function waitForLine(child: Child, match: (line: Record<string, unknown>) => boolean, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = child.lines.find(match);
    if (found !== undefined) return found;
    const exited = child.proc.exitCode !== null || child.proc.signalCode !== null;
    if (exited || Date.now() > deadline) {
      throw new Error(`log line not found (exited: ${String(exited)}); stderr: ${child.stderr()}; last lines: ${JSON.stringify(child.lines.slice(-5))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** SIGKILL (TerminateProcess on Windows) and wait for the exit. */
export async function kill(child: Child): Promise<void> {
  if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGKILL");
  await child.exited;
}

/** Environment of a worker child process (worker_rw login, the test Valkey, short intervals). */
export function workerEnv(prefix: string, overrides: Record<string, string> = {}): Record<string, string> {
  const valkey = new URL(inject("valkeyUrl"));
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL_WORKER: inject("workerDbUrl"),
    VALKEY_URL: `${valkey.protocol}//${valkey.host}`,
    VALKEY_USERNAME: inject("valkeyUsername"),
    VALKEY_PASSWORD: inject("valkeyPassword"),
    BULLMQ_PREFIX: prefix,
    WORKER_RELAY_INTERVAL_MS: "100",
    WORKER_SWEEP_INTERVAL_MS: "300",
    WORKER_HEARTBEAT_INTERVAL_MS: "1000",
    WORKER_OUTBOX_STALE_MS: "1000",
    WORKER_CONVERSION_LEASE_MS: "4000",
    WORKER_CONVERSION_TIMEOUT_MS: "1500",
    WORKER_DEV_ALLOW_HTTP: "true",
    WORKER_DEV_ALLOW_LOOPBACK: "true",
    // A job left active by a killed process is re-queued within about 3 s instead of 60 s.
    WORKER_LOCK_DURATION_MS: "2000",
    WORKER_STALLED_INTERVAL_MS: "1000",
    ...overrides,
  };
}
