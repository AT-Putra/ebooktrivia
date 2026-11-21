// Valkey for the integration tests: the dev stack's ACL user `worker` by default (the same ACL as
// production minus the password), one unique BullMQ prefix per test so tests never share keys.
import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { inject } from "vitest";
import { redisOptions } from "../../src/queues.ts";
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

const usedPrefixes = new Set<string>();

/** A BullMQ prefix of its own; every one handed out is removed again after the file (removeUsedPrefixes, test/support/cleanup.ts). */
export const uniquePrefix = (): string => {
  const prefix = `t${randomBytes(5).toString("hex")}`;
  usedPrefixes.add(prefix);
  return prefix;
};

/**
 * Removes every key of the prefixes this file handed out (its queues, the workers' and the harness processes' keys), so no run
 * leaves keys in the shared Valkey. Runs after the file's own hooks have closed its workers and queues.
 */
export async function removeUsedPrefixes(): Promise<void> {
  if (usedPrefixes.size === 0) return;
  const client = new Redis({ ...redisOptions(testValkey()), maxRetriesPerRequest: 1 });
  try {
    for (const prefix of usedPrefixes) {
      let cursor = "0";
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 1000);
        if (keys.length > 0) await client.unlink(...keys);
        cursor = next;
      } while (cursor !== "0");
    }
    usedPrefixes.clear();
  } finally {
    client.disconnect();
  }
}

/** Removes every key of a test prefix (all queues of it). */
export async function obliterate(queues: Iterable<Queue>): Promise<void> {
  for (const queue of queues) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  }
}
