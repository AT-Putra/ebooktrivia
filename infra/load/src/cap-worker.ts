// worker_threads entry of the Cap proof-of-work solver (cap-pool.ts): one challenge in, its solutions out.
import { parentPort } from "node:worker_threads";
import { type CapParams, solveChallenge } from "./cap-solver.ts";

if (parentPort === null) throw new Error("cap-worker.ts runs as a worker thread");
const port = parentPort;
port.on("message", (job: { readonly id: number; readonly token: string; readonly params: CapParams }) => {
  port.postMessage({ id: job.id, solutions: solveChallenge(job.token, job.params) });
});
