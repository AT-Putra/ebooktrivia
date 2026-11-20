// In-memory set of lp_domains hosts for /caddy/ask (internal process). Requests never query the
// database: the set is reloaded in full
//   - on every NOTIFY lp_domains_changed (migration 0003: one per committed statement),
//   - every time the LISTEN connection is (re)established (postgres.js reconnects it and calls
//     onlisten; a change committed while it was down produced a NOTIFY nobody heard),
//   - every reloadMs as a safety net.
// Reloads are serialized and coalesced: a burst of notifications costs at most one extra reload,
// and every request for a reload is answered by a load that started after it. A failed reload
// keeps the previous set (logged), so a database hiccup does not take TLS issuance down.
import type postgres from "postgres";
// The subpath only: the internal process must not load the rest of core (test/internal.int.test.ts).
import { normalizeHost } from "@ebooktrivia/core/hosts";
import type { Logger } from "./log.ts";

export const LP_DOMAINS_CHANNEL = "lp_domains_changed";

export interface DomainSet {
  has(host: string): boolean;
  readonly size: number;
  /** Resolves after a full load that started after this call. */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

export async function startDomainSet(sql: postgres.Sql, options: { readonly reloadMs: number; readonly log: Logger }): Promise<DomainSet> {
  let hosts = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  let queued = false;

  const loadOnce = async (): Promise<void> => {
    try {
      const rows = await sql<{ host: string }[]>`SELECT host FROM public.lp_domains`;
      const next = new Set<string>();
      for (const { host } of rows) {
        const normalized = normalizeHost(host);
        if (normalized !== null) next.add(normalized);
      }
      hosts = next;
    } catch (err) {
      options.log.error({ err }, "lp_domains reload failed; keeping the previous set");
    }
  };
  const reload = (): Promise<void> => {
    if (queued) return tail;
    queued = true;
    tail = tail.then(() => {
      queued = false;
      return loadOnce();
    });
    return tail;
  };

  const listener = await sql.listen(
    LP_DOMAINS_CHANNEL,
    () => void reload(),
    () => void reload(),
  );
  await reload();
  const timer = setInterval(() => void reload(), options.reloadMs);
  timer.unref();

  return {
    has: (host) => hosts.has(host),
    get size() {
      return hosts.size;
    },
    reload,
    stop: async () => {
      clearInterval(timer);
      await listener.unlisten();
      await tail;
    },
  };
}
