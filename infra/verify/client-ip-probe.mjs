// Temporary stand-in for public@b during the client-address check (infra/verify/client-ip-probe.sh).
// It runs inside the public image with the same edge listener as the apps (packages/edge) and the
// same environment (TRUSTED_PROXY_IP and EDGE_HOST from the quadlet). Every request except /livez
// gets what an app sees: the client address the edge listener resolved and the TCP peer. Two
// extra paths serve the drain check of infra/verify/local/stack-sim.sh:
//   GET  /__probe/slow?ms=N   answers after N ms (at most 30 s): a request in flight during a drain
//   POST /__probe/echo        reads the body and answers with its size
// PROBE_EXIT_ON_SIGTERM=1 makes it exit at once on SIGTERM instead of draining: the negative case
// that the drain check must catch.
import { drainOnSignals, loadEdgeConfig, startEdgeServer } from "/app/packages/edge/src/index.ts";

const log = (message) => {
  process.stdout.write(`${JSON.stringify({ level: "info", role: "client-ip-probe", msg: message })}\n`);
};
const config = loadEdgeConfig(process.env);
const json = (res, body) => {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
};
const edge = await startEdgeServer({
  ...config,
  handle: (req, res) => {
    const url = new URL(req.url ?? "/", "http://probe.invalid");
    if (url.pathname === "/__probe/slow") {
      const ms = Math.min(Number(url.searchParams.get("ms") ?? "0") || 0, 30_000);
      setTimeout(() => {
        json(res, { probe: "slow", ms });
      }, ms);
      return;
    }
    if (req.method === "POST") {
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
      });
      req.on("end", () => {
        json(res, { probe: "post", bytes });
      });
      return;
    }
    json(res, {
      probe: "client-ip",
      clientIp: req.headers["x-forwarded-for"] ?? null,
      peer: req.socket.remoteAddress ?? null,
      forwardedProto: req.headers["x-forwarded-proto"] ?? null,
      trustedProxy: config.trustedProxy,
    });
  },
  log,
});
if (process.env.PROBE_EXIT_ON_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.exit(0);
  });
} else {
  drainOnSignals(() => edge.drain(), log);
}
log(`client-ip probe listening on ${config.host}:${String(edge.port)}`);
