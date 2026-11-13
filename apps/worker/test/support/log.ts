import { Writable } from "node:stream";
import { createLogger, type Logger } from "../../src/log.ts";

/** A logger whose JSON lines are collected in memory. */
export function captureLogger(level: "debug" | "info" | "warn" | "error" = "info"): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString("utf8").split("\n")) if (line !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  return { log: createLogger({ level, role: "worker" }, stream), lines };
}
