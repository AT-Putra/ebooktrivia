// Valkey for the integration tests: the dev stack's ACL user `worker` by default (the same ACL as
// production minus the password), one unique BullMQ prefix per test so tests never share keys.
import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import { inject } from "vitest";
import type { ValkeyConfig } from "../../src/worker-config.ts";

export function testValkey(): ValkeyConfig {
  const url = new URL(inject("valkeyUrl"));
  return {
    host: url.hostname,
    port: Number(url.port === "" ? "6379" : url.port),
    db: 0,
    username: inject("valkeyUsername"),
    password: inject("valkeyPassword"),
    tls: url.protocol === "rediss:",
  };
}

export const uniquePrefix = (): string => `t${randomBytes(5).toString("hex")}`;

/** Removes every key of a test prefix (all queues of it). */
export async function obliterate(queues: Iterable<Queue>): Promise<void> {
  for (const queue of queues) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  }
}
