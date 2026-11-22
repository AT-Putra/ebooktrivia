// argon2id for admin passwords (Better Auth's emailAndPassword.password hook) and recovery codes.
// Parameters: OWASP's baseline argon2id configuration (m = 19 MiB, t = 2, p = 1), stored in each
// PHC string, so they can be raised later and old hashes still verify. At most MAX_CONCURRENT
// hashes run at once in this process: each holds 19 MiB outside the V8 heap, and the admin
// container has 600 MiB (infra/quadlet/admin.container).
import { hash, verify } from "@node-rs/argon2";
import { processWide } from "../process-wide.ts";

export const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
/** Inputs longer than this are refused before hashing (Better Auth caps passwords at 128). */
export const MAX_SECRET_LENGTH = 256;
const MAX_CONCURRENT = 4;

// Per process, not per bundle (lib/process-wide.ts): the limit bounds this process's memory (19 MiB per hash).
const slots = processWide("argon2-slots", () => ({ running: 0, queue: [] as (() => void)[] }));

/**
 * A finishing task hands its slot straight to the next queued one (running stays the same), so a
 * task started in between cannot take the freed slot as well (argon2-limit.test.ts).
 */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (slots.running < MAX_CONCURRENT) slots.running += 1;
  else await new Promise<void>((resolve) => slots.queue.push(resolve));
  try {
    return await task();
  } finally {
    const next = slots.queue.shift();
    if (next === undefined) slots.running -= 1;
    else next();
  }
}

export function hashSecret(secret: string): Promise<string> {
  if (secret.length > MAX_SECRET_LENGTH) return Promise.reject(new RangeError("secret too long"));
  // The package's default algorithm is argon2id (its Algorithm enum is a const enum, which
  // isolatedModules cannot import); argon2.test.ts asserts the "$argon2id$" prefix.
  return limited(() => hash(secret, ARGON2_OPTIONS));
}

/** False for a wrong secret, an over-long input or a malformed / non-argon2id hash; never throws. */
export async function verifySecret(phc: string, secret: string): Promise<boolean> {
  if (secret.length > MAX_SECRET_LENGTH || !phc.startsWith("$argon2id$")) return false;
  try {
    return await limited(() => verify(phc, secret));
  } catch {
    return false;
  }
}
