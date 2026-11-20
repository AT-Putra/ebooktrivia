// Superuser connection to the test database + fixture rows (inserted as the superuser: bypasses
// grants, not triggers). The code under test connects with the worker / internal LOGIN roles.
import { randomBytes } from "node:crypto";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, inject } from "vitest";

export const sql = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 8, onnotice: () => undefined });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

export const suffix = (): string => randomBytes(4).toString("hex");
/** A random suffix of letters only (outbox topics allow [a-z_]). */
export const letters = (): string => Array.from(randomBytes(6), (b) => String.fromCharCode(0x61 + (b % 26))).join("");

export function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("query returned no row");
  return row;
}

/** Polls `check` until it returns true (or throws after `timeoutMs`). */
export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 30_000, everyMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Catalog {
  readonly productId: string;
  readonly programId: string;
  readonly landingPageId: string;
}

/** Product + published program on sale now + landing page. */
export async function createCatalog(opts: { salesEndAt?: Date; graceDays?: number; status?: string } = {}): Promise<Catalog> {
  const product = first(await sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const salesEnd = opts.salesEndAt ?? new Date(Date.now() + 30 * 86_400_000);
  const program = first(
    await sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`prog-${suffix()}`}, 'Program', ${opts.status ?? "published"},
              ${new Date(salesEnd.getTime() - 60 * 86_400_000)}, ${salesEnd}, ${opts.graceDays ?? 30})
      RETURNING id`,
  );
  const lp = first(
    await sql<{ id: string }[]>`
      INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program.id}) RETURNING id`,
  );
  return { productId: product.id, programId: program.id, landingPageId: lp.id };
}

/** `n` orders of the catalog in one statement. */
export async function createOrders(catalog: Catalog, n: number, opts: { status?: string; expiresAt?: Date } = {}): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email,
                        buyer_key, amount_idr, status, expires_at)
    SELECT replace(gen_random_uuid()::text, '-', ''), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)), ${catalog.landingPageId},
           ${catalog.programId}, ${catalog.productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid',
           sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000,
           ${opts.status ?? "paid"}, ${opts.expiresAt ?? new Date(Date.now() + 3_600_000)}
      FROM generate_series(1, ${n}::int)
    RETURNING id`;
  return rows.map((r) => r.id);
}

/** One `meta`/`mt` conversion event per order, due now unless overridden. */
export async function createConversionEvents(
  orderIds: readonly string[],
  opts: { status?: string; attempts?: number; nextAttemptAt?: Date; leaseUntil?: Date | null } = {},
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO conversion_events (order_id, sink, kind, status, txid, event_id, value_idr, attempts, next_attempt_at, lease_until)
    SELECT o, 'meta', 'mt', ${opts.status ?? "pending"}, 'tx-' || o::text, gen_random_uuid(), 49000, ${opts.attempts ?? 0},
           ${opts.nextAttemptAt ?? new Date(Date.now() - 1000)}, ${opts.leaseUntil ?? null}
      FROM unnest(${orderIds as string[]}::uuid[]) AS o
    RETURNING id`;
  return rows.map((r) => r.id);
}

/** Outbox rows of `topic` (payload {n}), as the SECURITY DEFINER enqueue_* functions would write them. */
export async function createOutboxRows(topic: string, n: number, opts: { availableAt?: Date; createdAt?: Date } = {}): Promise<string[]> {
  const tag = suffix();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO outbox (topic, dedupe_key, payload, available_at, created_at)
    SELECT ${topic}, ${`${topic}:${tag}:`} || g::text, jsonb_build_object('n', g), ${opts.availableAt ?? new Date(Date.now() - 1000)},
           ${opts.createdAt ?? new Date()}
      FROM generate_series(1, ${n}::int) AS g
    RETURNING id`;
  return rows.map((r) => r.id);
}
