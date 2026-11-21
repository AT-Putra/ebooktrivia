// The periodic landing-page hosting run (US-023, lib/settings/lp-hosting.ts), started once per server
// process by src/instrumentation.ts: re-links /srv/lp/hosts to public.lp_served_hosts() (a sync that
// failed after a commit is retried here) and removes what a crashed publish left behind. Every 5
// minutes and once shortly after start; failures are logged and retried on the next tick.
import { logEvent } from "../log.ts";
import { sweepLpFiles, syncLpHosts } from "../settings/lp-hosting.ts";
import { getRuntime } from "./runtime.ts";

const INTERVAL_MS = 5 * 60_000;
const KEY = Symbol.for("ebooktrivia.admin.lpHostingSweeper");
type Holder = { [KEY]?: NodeJS.Timeout };

export function startLpHostingSweeper(): void {
  const holder = globalThis as Holder;
  if (holder[KEY] !== undefined) return;
  const tick = (): void => {
    getRuntime()
      .then(async (rt) => {
        const synced = await syncLpHosts(rt.sql, rt.settings);
        const swept = await sweepLpFiles(rt.sql, rt.settings);
        if (synced.linked + synced.removed + synced.leftAlone + swept > 0) logEvent("info", "admin.lp_hosting_reconciled", { ...synced, swept });
      })
      .catch((error: unknown) => {
        logEvent("warn", "admin.lp_hosting_reconcile_failed", {}, error);
      });
  };
  holder[KEY] = setInterval(tick, INTERVAL_MS);
  holder[KEY].unref();
  setTimeout(tick, 5_000).unref();
}
