// Production entry of the admin app: `node src/server.ts` in the standalone build (image
// infra/images/app/Containerfile, quadlet infra/quadlet/admin.container). Next.js runs behind the
// edge listener of @ebooktrivia/edge: /livez with drain on SIGTERM, and X-Forwarded-For believed
// only from Caddy's pinned IP (TRUSTED_PROXY_IP), which the admin login rate limit keys on.
// `next dev` and `next start` do not use this file.
import { join } from "node:path";
import { startNextBehindEdge } from "@ebooktrivia/edge";
import next from "next";

startNextBehindEdge(join(import.meta.dirname, ".."), process.env, next, (message) => {
  process.stdout.write(`${JSON.stringify({ level: "info", role: "admin-edge", msg: message })}\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : "startup failed"}\n`);
  process.exit(1);
});
