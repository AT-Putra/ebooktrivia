// In-memory set of served LP hosts for /caddy/ask (internal process): public.lp_served_hosts(), the
// registered domains of ACTIVE landing pages hosted as a ZIP with a live version (US-023; the same
// set the admin console links under /srv/lp/hosts). Requests never query the database: the set is
// reloaded in full
//   - on every NOTIFY lp_domains_changed (one per committed statement: lp_domains, migration 0003, and
//     the active / hosting / current version of landing_pages, sql/triggers.sql US-023),
//   - every time the LISTEN connection is (re)established (postgres.js reconnects it and calls
//     onlisten; a change committed while it was down produced a NOTIFY nobody heard),
//   - every reloadMs as a safety net.
// Reloads are serialized and coalesced: a burst of notifications costs at most one extra reload,
// and every request for a reload is answered by a load that started after it. A failed reload
// EMPTIES the set (fail closed, logged; US-023): the change it was meant to pick up may be a
// deactivated page or a removed domain, which must not keep getting certificates. Only issuance of
// NEW certificates waits for the next good reload (the timer, a NOTIFY or a reconnect); Caddy keeps
// serving the certificates it has, and requests answered meanwhile come from memory, never the DB.
// After a failure the reload is retried on its own, 5 s later and then doubling up to 1 min, and
// ALERT_AFTER failures in a row call onAlert once (internal.ts records an alerts row).
import type postgres from "postgres";
// The subpath only: the internal process must not load the rest of core (test/internal.int.test.ts).
import { normalizeHost } from "@ebooktrivia/core/hosts";
import type { Logger } from "./log.ts";

export const LP_DOMAINS_CHANNEL = "lp_domains_changed";

export const ALERT_AFTER = 3;

export interface DomainSet {
  has(host: string): boolean;
  readonly size: number;
  /** Resolves after a full load that started after this call. */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

export interface DomainSetOptions {
  readonly reloadMs: number;
  readonly log: Logger;
  /** First retry after a failed reload (doubling up to retryMaxMs). */
  readonly retryMs?: number;
  readonly retryMaxMs?: number;
  /** Called once when ALERT_AFTER reloads in a row have failed. */
  readonly onAlert?: (failures: number) => Promise<void>;
}

export async function startDomainSet(sql: postgres.Sql, options: DomainSetOptions): Promise<DomainSet> {
  let hosts = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  let queued = false;
  let failures = 0;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;

  const loadOnce = async (): Promise<void> => {
    try {
      const rows = await sql<{ host: string }[]>`SELECT host FROM public.lp_served_hosts()`;
      const next = new Set<string>();
      for (const { host } of rows) {
        const normalized = normalizeHost(host);
        if (normalized !== null) next.add(normalized);
      }
      hosts = next;
      failures = 0;
    } catch (err) {
      hosts = new Set();
      failures++;
      options.log.error({ err, failures }, "lp hosts reload failed; refusing every host until a reload succeeds");
      if (failures === ALERT_AFTER) {
        await options.onAlert?.(failures).catch((alertErr: unknown) => {
          options.log.error({ err: alertErr }, "lp hosts reload alert could not be stored");
        });
      }
      if (!stopped && retry === null) {
        const delay = Math.min((options.retryMs ?? 5000) * 2 ** (failures - 1), options.retryMaxMs ?? 60_000);
        retry = setTimeout(() => {
          retry = null;
          void reload();
        }, delay);
        retry.unref();
      }
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
      stopped = true;
      clearInterval(timer);
      if (retry !== null) clearTimeout(retry);
      await listener.unlisten();
      await tail;
    },
  };
}
