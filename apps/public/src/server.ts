// Production entry of the public app: `node src/server.ts` in the standalone build (image
// infra/images/app/Containerfile, quadlet infra/quadlet/public@.container). Next.js runs behind the
// edge listener of @ebooktrivia/edge: /livez with drain on SIGTERM for Caddy's load balancer, and
// X-Forwarded-For believed only from Caddy's pinned IP (TRUSTED_PROXY_IP). `next dev` and
// `next start` do not use this file.
import { join } from "node:path";
import { startNextBehindEdge } from "@ebooktrivia/edge";
import next from "next";

startNextBehindEdge(join(import.meta.dirname, ".."), process.env, next, (message) => {
  process.stdout.write(`${JSON.stringify({ level: "info", role: "public-edge", msg: message })}\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : "startup failed"}\n`);
  process.exit(1);
});
