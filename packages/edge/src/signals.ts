// SIGTERM / SIGINT start the drain (edge-server.ts) and exit 0 once it has finished, or 1 when it
// fails. A second signal exits 1 at once. podman stop sends SIGTERM and waits StopTimeout (the
// quadlets set it above EDGE_DRAIN_MS + EDGE_CLOSE_TIMEOUT_MS) before SIGKILL.
export interface SignalProcess {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): void;
}

export function drainOnSignals(drain: () => Promise<void>, log: (message: string) => void, proc: SignalProcess = process): void {
  let stopping = false;
  const handle = (signal: "SIGTERM" | "SIGINT") => () => {
    if (stopping) {
      log(`second ${signal}: exiting now`);
      proc.exit(1);
      return;
    }
    stopping = true;
    log(`${signal}: draining`);
    drain().then(
      () => {
        proc.exit(0);
      },
      (error: unknown) => {
        log(`drain failed: ${error instanceof Error ? error.message : "error"}`);
        proc.exit(1);
      },
    );
  };
  proc.on("SIGTERM", handle("SIGTERM"));
  proc.on("SIGINT", handle("SIGINT"));
}
