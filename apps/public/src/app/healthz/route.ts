// GET /healthz (US-015): the deep health of this instance for Uptime Kuma and the deploy's last check. Caddy serves it
// on api.<DOMAIN> to the monitor's address only (MONITOR_ALLOWED_CIDRS) and answers 404 to everyone else and on every
// other host; the shallow /livez of packages/edge stays the load balancer's. 200 {"status":"ok"} or 503
// {"status":"degraded"} and nothing else: no version, host, error text or timing. Each dependency (PostgreSQL with the
// worker's heartbeat, Valkey) is cut off after 2 s, so a hung one is a 503, not a hang. Never cached, Node runtime.
import { checkHealth } from "@ebooktrivia/db/health";
import { logEvent } from "../../lib/log.ts";
import { getRuntime } from "../../lib/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const answer = (ok: boolean): Response =>
  Response.json({ status: ok ? "ok" : "degraded" }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });

export async function GET(): Promise<Response> {
  try {
    const { order } = await getRuntime();
    const result = await checkHealth({ sql: order.sql, ping: () => order.valkey.ping() });
    if (!result.ok) logEvent("warn", "healthz.degraded", { route: "healthz", kind: result.failed.join(",") });
    return answer(result.ok);
  } catch (error) {
    logEvent("error", "healthz.degraded", { route: "healthz", kind: "runtime" }, error);
    return answer(false);
  }
}
