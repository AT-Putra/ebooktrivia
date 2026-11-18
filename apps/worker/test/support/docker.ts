// A throwaway Valkey without ACLs (same image as the dev stack and CI) for the one test that runs a
// real FLUSHALL: the ACL users of the shared Valkey are -@dangerous, so they cannot.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Redis } from "ioredis";

const run = promisify(execFile);
// The production image, by digest (infra/quadlet/valkey.container; infra/verify/src/quadlets.test.ts checks it).
export const VALKEY_IMAGE = "docker.io/valkey/valkey:9.1.3@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7";

export interface ThrowawayValkey {
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

export async function startThrowawayValkey(): Promise<ThrowawayValkey> {
  const { stdout } = await run("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::6379", VALKEY_IMAGE, "valkey-server", "--save", "", "--appendonly", "no"]);
  const id = stdout.trim();
  const stop = async () => {
    await run("docker", ["rm", "-f", id]).catch(() => undefined);
  };
  try {
    const mapped = (await run("docker", ["port", id, "6379/tcp"])).stdout.trim().split("\n")[0] ?? "";
    const port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0) throw new Error(`docker port said ${mapped}`);
    const client = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => 200 });
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await client.connect().catch(() => undefined);
          await client.ping();
          break;
        } catch {
          if (Date.now() > deadline) throw new Error("throwaway valkey did not answer PING");
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    } finally {
      client.disconnect();
    }
    return { host: "127.0.0.1", port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
