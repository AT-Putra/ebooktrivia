// The Owner's customer-service (CS) contact as the buyer site reads it (public_rw may read ONLY the three fields: whatsapp, email, hours;
// packages/db sql/grants.sql). It feeds the one help block every buyer page shows (components/help/help-block.tsx).
//
// Cheap and never in the way of a page: the answer is kept in this process for a short time (READ_TTL_MS, so a change the Owner saves is
// on the site within the minute), one read serves every request that arrives while it runs, a read that takes longer than READ_TIMEOUT_MS
// or fails is logged with a code (cs_contact.read_failed) and the page renders WITHOUT the block (the last good answer, when there is one,
// keeps being shown), and a failed read is not tried again for FAILURE_TTL_MS, so a database that is down is not hammered by every page.
import { type CsContact, isCsEmail, isCsHours, NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { isIdMobileE164 } from "@ebooktrivia/core/phone";
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

export async function readCsContact(sql: Sql): Promise<CsContact> {
  const [row] = await sql<Row[]>`SELECT whatsapp, email, hours FROM public.cs_contact LIMIT 1`;
  return csContactOf(row);
}

export interface CsContactCache {
  /** The contact: from memory while it is fresh, else one shared read. Never rejects: a failed read answers the last good value (or none). */
  get(): Promise<CsContact>;
  /** Forgets what is held, so the next get() reads again (tests). */
  clear(): void;
}

export interface CsContactCacheOptions {
  readonly read: () => Promise<CsContact>;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ReadTimeout());
        }, timeoutMs);
      });
      current = await Promise.race([options.read(), timeout]);
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

  return {
    get() {
      if (current !== null && now() < freshUntil) return Promise.resolve(current);
      inFlight ??= refresh();
      return inFlight;
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
    read: async () => readCsContact((await getRuntime()).order.sql),
    onFailure: (code, error) => {
      logEvent("warn", "cs_contact.read_failed", { code }, error);
    },
  });
  return holder[KEY];
}

/** The CS contact for the page being rendered; `NO_CS_CONTACT` (no block) when it cannot be read. */
export function getCsContact(): Promise<CsContact> {
  return csContactCache().get();
}
