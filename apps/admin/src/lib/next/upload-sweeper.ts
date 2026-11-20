// The periodic upload sweep (lib/settings/uploads.ts sweepUploads), started once per server process
// by src/instrumentation.ts. The admin app is the only process that may write /srv/data, so it
// sweeps for every admin; `init` sweeps too. Failures are logged (type and code only) and retried
// on the next tick.
import { sweepUploads } from "../settings/uploads.ts";
import { logEvent } from "../log.ts";
import { getRuntime } from "./runtime.ts";

const INTERVAL_MS = 15 * 60_000;
const KEY = Symbol.for("ebooktrivia.admin.uploadSweeper");
type Holder = { [KEY]?: NodeJS.Timeout };

export function startUploadSweeper(): void {
  const holder = globalThis as Holder;
  if (holder[KEY] !== undefined) return;
  const tick = (): void => {
    getRuntime()
      .then((rt) => sweepUploads(rt.sql, rt.settings))
      .then((result) => {
        if (Object.values(result).some((n) => n > 0)) logEvent("info", "admin.uploads_swept", { ...result });
      })
      .catch((error: unknown) => {
        logEvent("warn", "admin.upload_sweep_failed", {}, error);
      });
  };
  holder[KEY] = setInterval(tick, INTERVAL_MS);
  holder[KEY].unref();
}
