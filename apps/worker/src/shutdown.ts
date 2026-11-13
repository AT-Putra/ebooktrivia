// Graceful SIGTERM / SIGINT: the first signal runs stop() (stop polling, let in-flight jobs finish,
// close Valkey, PostgreSQL and HTTP pools) and exits 0, or 1 when stopping fails. A second signal,
// or stop() taking longer than timeoutMs, exits 1 at once. (On Windows a signal from another
// process terminates without running handlers; Ctrl+C still delivers SIGINT.)
import type { Logger } from "./log.ts";

interface SignalProcess {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): void;
}

export function onShutdown(
  stop: () => Promise<void>,
  log: Logger,
  options: { readonly proc?: SignalProcess; readonly timeoutMs?: number } = {},
): void {
  const proc = options.proc ?? process;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let stopping = false;
  const handle = (signal: string) => () => {
    if (stopping) {
      log.warn({ signal }, "second signal: exiting now");
      proc.exit(1);
      return;
    }
    stopping = true;
    log.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      log.error({ timeoutMs }, "graceful shutdown timed out");
      proc.exit(1);
    }, timeoutMs);
    timer.unref();
    stop().then(
      () => {
        clearTimeout(timer);
        log.info("stopped");
        proc.exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log.error({ err }, "graceful shutdown failed");
        proc.exit(1);
      },
    );
  };
  proc.on("SIGTERM", handle("SIGTERM"));
  proc.on("SIGINT", handle("SIGINT"));
}
