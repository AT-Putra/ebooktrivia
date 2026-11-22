// The Cap token pool of orders-50pm.js. Checkout needs a Cap token per order (AC-S3); the real widget
// solves a proof of work in the buyer's browser. k6 cannot solve one per order (50 sub-challenges of 4 hex
// digits is 3 million SHA-256 hashes, seconds of CPU per token), so this tool does it beforehand, with
// native hashing on every core, through the app's OWN endpoints (POST /api/v1/cap/{lpKey}/challenge, then
// /redeem), with no code bypass and the production difficulty. A token is single use, bound to the landing
// page, and valid until its challenge's expiry plus 10 minutes (about 20 minutes after it was issued): run
// this right before k6 (run.sh orders does) and make the pool one token per planned order, plus a margin.
//
//   node infra/load/src/cap-pool.ts --api https://api.<DOMAIN> --lp-key lp_... --origin https://<lp host>
//        --count 560 --out cap-pool.json [--max-rps 8] [--threads 8]
//
// The Cap routes are rate limited per client IP (captcha.ip_cap per captcha.ip_window_seconds; two requests per
// token): --max-rps stays under it. The staging limits to set for the run are in infra/load/README.md.
import { writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { positiveNumber } from "./args.ts";
import { type CapParams, solveChallenge } from "./cap-solver.ts";

export interface PoolToken {
  readonly token: string;
  /** Epoch milliseconds: the token is refused after this. */
  readonly expires: number;
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export interface PoolOptions {
  readonly api: string;
  readonly lpKey: string;
  readonly origin: string;
  readonly count: number;
  /** Requests per second to the Cap routes (a token takes two). */
  readonly maxRps: number;
  readonly fetch: FetchLike;
  /** Solves one challenge; the CLI runs worker threads, the tests run the solver in-process. */
  readonly solve: (token: string, params: CapParams) => Promise<number[]>;
  /** How many tokens are worked on at once. */
  readonly concurrency: number;
  readonly onProgress?: (done: number, total: number) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Spaces the requests of every task by 1/maxRps. */
function slotter(maxRps: number): () => Promise<void> {
  const gap = 1000 / maxRps;
  let next = Date.now();
  return async () => {
    const at = Math.max(next, Date.now());
    next = at + gap;
    const wait = at - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

export async function generatePool(options: PoolOptions): Promise<PoolToken[]> {
  const base = `${options.api.replace(/\/+$/, "")}/api/v1/cap/${options.lpKey}`;
  const headers = { origin: options.origin, "content-type": "application/json", accept: "application/json" };
  const slot = slotter(options.maxRps);
  const tokens: PoolToken[] = [];
  let issued = 0;
  const post = async (path: string, body?: unknown): Promise<unknown> => {
    await slot();
    const response = await options.fetch(`${base}/${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 429) throw new Error(`the Cap route answered 429 (rate limited): lower --max-rps or raise captcha.ip_cap (README, "Limits for the run")`);
    if (response.status !== 200) throw new Error(`the Cap route ${path} answered ${String(response.status)}`);
    return response.json();
  };
  const one = async (): Promise<PoolToken> => {
    const challenge = await post("challenge");
    if (!isRecord(challenge) || typeof challenge["token"] !== "string" || !isRecord(challenge["challenge"])) throw new Error("unexpected challenge answer");
    const { c, s, d } = challenge["challenge"];
    if (typeof c !== "number" || typeof s !== "number" || typeof d !== "number") throw new Error("unexpected challenge parameters");
    const solutions = await options.solve(challenge["token"], { c, s, d });
    const redeemed = await post("redeem", { token: challenge["token"], solutions });
    if (!isRecord(redeemed) || redeemed["success"] !== true || typeof redeemed["token"] !== "string" || typeof redeemed["expires"] !== "number") {
      throw new Error("the redeem was refused");
    }
    return { token: redeemed["token"], expires: redeemed["expires"] };
  };
  const lanes = Array.from({ length: Math.min(options.concurrency, options.count) }, async () => {
    while (issued < options.count) {
      issued++;
      tokens.push(await one());
      options.onProgress?.(tokens.length, options.count);
    }
  });
  await Promise.all(lanes);
  return tokens;
}

/** A pool of worker threads, each solving one challenge at a time. */
export function threadSolver(threads: number): { solve: (token: string, params: CapParams) => Promise<number[]>; close: () => Promise<void> } {
  const workers = Array.from({ length: threads }, () => new Worker(new URL("./cap-worker.ts", import.meta.url)));
  const idle = [...workers];
  const waiting: ((w: Worker) => void)[] = [];
  let nextId = 0;
  const take = (): Promise<Worker> => {
    const w = idle.pop();
    return w === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(w);
  };
  const give = (w: Worker): void => {
    const waiter = waiting.shift();
    if (waiter === undefined) idle.push(w);
    else waiter(w);
  };
  return {
    solve: async (token, params) => {
      const worker = await take();
      const id = nextId++;
      try {
        return await new Promise<number[]>((resolve, reject) => {
          const onMessage = (m: { id: number; solutions: number[] }): void => {
            if (m.id !== id) return;
            cleanup();
            resolve(m.solutions);
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(error);
          };
          const cleanup = (): void => {
            worker.off("message", onMessage);
            worker.off("error", onError);
          };
          worker.on("message", onMessage);
          worker.on("error", onError);
          worker.postMessage({ id, token, params });
        });
      } finally {
        give(worker);
      }
    },
    close: async () => {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

export const inProcessSolver = (token: string, params: CapParams): Promise<number[]> => Promise.resolve(solveChallenge(token, params));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      api: { type: "string" },
      "lp-key": { type: "string" },
      origin: { type: "string" },
      count: { type: "string" },
      out: { type: "string" },
      "max-rps": { type: "string", default: "8" },
      threads: { type: "string" },
    },
  });
  const { api, "lp-key": lpKey, origin, out } = values;
  const count = Number(values.count);
  if (api === undefined || lpKey === undefined || origin === undefined || out === undefined || !Number.isInteger(count) || count < 1) {
    throw new Error("usage: cap-pool.ts --api <https://api.DOMAIN> --lp-key <lp_...> --origin <https://lp host> --count <n> --out <file> [--max-rps 8] [--threads n]");
  }
  const threads = values.threads === undefined ? Math.max(1, Math.min(availableParallelism(), 16)) : positiveNumber("threads", values.threads, { integer: true });
  const maxRps = positiveNumber("max-rps", values["max-rps"]);
  const solver = threadSolver(threads);
  const started = Date.now();
  try {
    const tokens = await generatePool({
      api,
      lpKey,
      origin,
      count,
      maxRps,
      fetch: (url, init) => fetch(url, init),
      solve: solver.solve,
      concurrency: threads,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) process.stderr.write(`cap-pool: ${String(done)}/${String(total)} tokens (${String(Math.round((Date.now() - started) / 1000))} s)\n`);
      },
    });
    tokens.sort((a, b) => a.expires - b.expires);
    await writeFile(out, `${JSON.stringify({ api_origin: api, lp_key: lpKey, generated_at: new Date().toISOString(), tokens })}\n`, { mode: 0o600 });
    process.stderr.write(`cap-pool: wrote ${String(tokens.length)} tokens to ${out}; the earliest expires ${new Date(tokens[0]?.expires ?? 0).toISOString()}\n`);
  } finally {
    await solver.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "cap-pool failed"}\n`);
    process.exit(1);
  });
}
