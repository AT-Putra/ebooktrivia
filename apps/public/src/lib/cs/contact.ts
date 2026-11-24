// The Owner's customer-service (CS) contact as the buyer site reads it (public_rw may read ONLY id, whatsapp, email and hours; packages/db
// sql/grants.sql). It feeds the one help block every buyer page shows (components/help/help-block.tsx).
//
// Cheap and never in the way of a page (stale-while-revalidate): the last good answer is served at once, also after it is older than READ_TTL_MS,
// and a refresh runs in the background (so a change the Owner saves is on the site within a minute, and a database that stalls never holds the root
// layout). Only the very first read, when there is no answer yet, is waited for, and only up to READ_TIMEOUT_MS. A read that takes longer or fails is
// logged with a code (cs_contact.read_failed) and the page renders WITHOUT the block until a later refresh succeeds (the last good answer, when there is
// one, keeps being shown). A read that times out is CANCELLED (the query is cancelled on the server), so it does not hold a pool connection, and a failed
// refresh is not tried again for FAILURE_TTL_MS, so a database that is down is not hammered by every page. One request sees one value (getCsContact is
// wrapped in React's cache()), so the layout's provider and a page's server block never disagree.
import { type CsContact, isCsEmail, isCsHours, NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { isIdMobileE164 } from "@ebooktrivia/core/phone";
import { cache } from "react";
import type { Sql } from "../db.ts";
import { logEvent } from "../log.ts";
import { getRuntime } from "../runtime.ts";

export const READ_TTL_MS = 30_000;
export const FAILURE_TTL_MS = 5_000;
export const READ_TIMEOUT_MS = 1_500;

interface Row {
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly hours: string | null;
}

/** The three fields as the page uses them; a value the checks of the table would have refused is dropped, never shown. */
export function csContactOf(row: Row | undefined): CsContact {
  if (row === undefined) return NO_CS_CONTACT;
  return {
    whatsapp: row.whatsapp !== null && isIdMobileE164(row.whatsapp) ? row.whatsapp : null,
    email: row.email !== null && isCsEmail(row.email) ? row.email : null,
    hours: row.hours !== null && isCsHours(row.hours) ? row.hours : null,
  };
}

/** `signal` aborts the query on the server (a read that timed out must not keep its connection busy). */
export async function readCsContact(sql: Sql, signal?: AbortSignal): Promise<CsContact> {
  const query = sql<Row[]>`SELECT whatsapp, email, hours FROM public.cs_contact WHERE id = 1`;
  const cancel = (): void => {
    query.cancel().catch(() => undefined);
  };
  if (signal?.aborted === true) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const [row] = await query;
    return csContactOf(row);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export interface CsContactCache {
  /**
   * The contact. With an answer in hand it is returned at once (a refresh starts in the background when it is older than the time to live); with
   * none yet, the first read is waited for (at most the timeout). Never rejects: a failed first read answers no contact.
   */
  get(): Promise<CsContact>;
  /** Resolves when no read is running (tests, and a clean stop). */
  idle(): Promise<void>;
  /** Forgets what is held, so the next get() reads again (tests). */
  clear(): void;
}

export interface CsContactCacheOptions {
  /** Reads the contact; `signal` aborts when the read ran past the timeout. */
  readonly read: (signal: AbortSignal) => Promise<CsContact>;
  /** Called with the reason of a failed or timed out read: a code, never a message. */
  readonly onFailure: (code: "read_failed" | "read_timeout", error: unknown) => void;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly failureTtlMs?: number;
  readonly timeoutMs?: number;
}

class ReadTimeout extends Error {
  constructor() {
    super("cs_contact read timed out");
    this.name = "ReadTimeout";
  }
}

export function createCsContactCache(options: CsContactCacheOptions): CsContactCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? READ_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  let current: CsContact | null = null;
  let freshUntil = 0;
  let inFlight: Promise<CsContact> | null = null;

  async function refresh(): Promise<CsContact> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ReadTimeout());
        }, timeoutMs);
      });
      current = await Promise.race([options.read(controller.signal), timeout]);
      freshUntil = now() + ttlMs;
    } catch (error) {
      options.onFailure(error instanceof ReadTimeout ? "read_timeout" : "read_failed", error);
      current ??= NO_CS_CONTACT;
      freshUntil = now() + failureTtlMs;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
    return current;
  }

  const start = (): Promise<CsContact> => {
    inFlight ??= refresh();
    return inFlight;
  };

  return {
    get() {
      if (current === null) return start();
      if (now() >= freshUntil) void start();
      return Promise.resolve(current);
    },
    async idle() {
      await inFlight;
    },
    clear() {
      current = null;
      freshUntil = 0;
    },
  };
}

const KEY = Symbol.for("ebooktrivia.public.cs_contact_cache");
type Holder = { [KEY]?: CsContactCache | undefined };

/** The process-wide cache (on globalThis, like the runtime, so `next dev` module reloads reuse it). */
export function csContactCache(): CsContactCache {
  const holder = globalThis as Holder;
  holder[KEY] ??= createCsContactCache({
    read: async (signal) => readCsContact((await getRuntime()).order.sql, signal),
    onFailure: (code, error) => {
      logEvent("warn", "cs_contact.read_failed", { code }, error);
    },
  });
  return holder[KEY];
}

/** The CS contact for the page being rendered (one value per request); `NO_CS_CONTACT` (no block) when it cannot be read. */
export const getCsContact = cache((): Promise<CsContact> => csContactCache().get());
