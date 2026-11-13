// A periodic task that never overlaps itself: run the tick, then wait intervalMs (or run again at
// once when the tick reports more work, e.g. the relay drained a full batch). stop() cancels the
// wait and resolves after the tick in flight, so shutdown never cuts a transaction in half.
import type { Logger } from "./log.ts";

export interface Loop {
  stop(): Promise<void>;
}

export function startLoop(options: { readonly name: string; readonly intervalMs: number; readonly log: Logger }, tick: () => Promise<boolean>): Loop {
  let stopped = false;
  const isStopped = (): boolean => stopped;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const run = async (): Promise<void> => {
    while (!isStopped()) {
      let more = false;
      try {
        more = await tick();
      } catch (err) {
        options.log.error({ loop: options.name, err }, "loop tick failed");
      }
      if (isStopped()) break;
      if (more) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, options.intervalMs);
      });
    }
  };
  const done = run();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      await done;
    },
  };
}
