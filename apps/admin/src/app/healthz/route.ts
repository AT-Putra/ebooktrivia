// GET /healthz (US-015): the console's deep health for Uptime Kuma and the deploy's last check. No session by design
// (guards.test.ts lists it as a public route): it answers 200 {"status":"ok"} or 503 {"status":"degraded"} and nothing
// else, and Caddy only lets the allowlisted addresses (ADMIN_ALLOWED_CIDRS, which include the monitor) reach this host.
// PostgreSQL with the worker's heartbeat and Valkey are each cut off after 2 s. Never cached, Node runtime.
import { adminHealth } from "../../lib/health.ts";
import { logEvent } from "../../lib/log.ts";
import { getRuntime } from "../../lib/next/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const answer = (ok: boolean): Response =>
  Response.json({ status: ok ? "ok" : "degraded" }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });

export async function GET(): Promise<Response> {
  try {
    const { sql } = await getRuntime();
    const result = await adminHealth(sql);
    if (!result.ok) logEvent("warn", "admin.healthz_degraded", { kind: result.failed.join(",") });
    return answer(result.ok);
  } catch (error) {
    logEvent("error", "admin.healthz_degraded", { kind: "runtime" }, error);
    return answer(false);
  }
}
