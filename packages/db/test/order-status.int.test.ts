// US-022: the order status page's two DB entry points (functions.sql) and the exactly-once claim of the
// browser MT pixel (orders.browser_mt_fired_at).
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState, suffix } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

let base: { landingPageId: string; programId: string; productId: string };
const LP_HOST = `lp-${suffix()}.example.test`;
const PIXELS = { meta: "1234567890123", tiktok: "ABCDEFGHIJKLMNOP", gtag: "AW-123456789", gtag_label: "AbC_12-xyz" };

beforeAll(async () => {
  const { productId, programId } = await createProgram();
  base = { landingPageId: await createLandingPage(programId), programId, productId };
  await sql`UPDATE public.landing_pages SET pixels = ${sql.json(PIXELS)} WHERE id = ${base.landingPageId}`;
  // The primary host is the first registered, not the first in the alphabet: the later registration sorts first.
  await sql`INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${base.landingPageId}, ${LP_HOST})`;
  await sql`INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${base.landingPageId}, ${`a-${LP_HOST}`})`;
});

/** `paidAgoMinutes`: when a paid order was paid (paid_at is set once: it is set here, with the status); null: no payment time. */
async function newOrder(status = "pending", overrides: Record<string, unknown> = {}, paidAgoMinutes: number | null = 0): Promise<{ id: string; publicId: string; eventId: string; code: string; phone: string }> {
  const row = { ...orderRow({ ...base, status: "pending" }), ...overrides };
  const { id, event_id: eventId } = first(await sql<{ id: string; event_id: string }[]>`INSERT INTO public.orders ${sql(row)} RETURNING id, event_id`);
  if (status !== "pending") {
    await sql`UPDATE public.orders SET status = ${status}, paid_at = CASE WHEN ${status} = 'paid' AND ${paidAgoMinutes}::int IS NOT NULL THEN now() - make_interval(mins => ${paidAgoMinutes}::int) END WHERE id = ${id}`;
  }
  return { id, publicId: row.public_id, eventId, code: row.order_code, phone: row.buyer_phone };
}

const status = (publicId: string, role: "public_rw" | "admin_rw" | "worker_rw" = "public_rw") =>
  asRole(role, (tx) => tx<Record<string, unknown>[]>`SELECT * FROM public.get_order_status(${publicId})`);
const claim = (publicId: string) => asRole("public_rw", (tx) => tx<Record<string, unknown>[]>`SELECT * FROM public.claim_browser_mt(${publicId})`);
const firedAt = async (id: string) => first(await sql<{ at: Date | null }[]>`SELECT browser_mt_fired_at AS at FROM public.orders WHERE id = ${id}`).at;

describe("get_order_status", () => {
  it("returns the page's fields for a known public id, with the buyer MASKED by the product's one rule (mask_name / mask_phone) and no raw name, phone, e-mail, internal id or attempt data", async () => {
    const order = await newOrder();
    const rows = await status(order.publicId);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["amount_idr", "lp_host", "masked_name", "masked_phone", "order_code", "pixels", "product_title", "status"]);
    expect(rows[0]).toMatchObject({ status: "pending", order_code: order.code, masked_name: "P***", masked_phone: `****${order.phone.slice(-3)}`, pixels: PIXELS });
    const text = JSON.stringify(rows);
    for (const secret of ["Pembeli", "buyer@example.invalid", order.phone, order.phone.slice(1), order.id, order.eventId]) expect(text, secret).not.toContain(secret);
  });

  it("gives the same masks as the winners banner for the same buyer (one masking rule)", async () => {
    const order = await newOrder("pending", { buyer_name: "Siti  Nur\tRahmawati", buyer_phone: "+6281234567890" });
    const [row] = await status(order.publicId);
    const [rule] = await sql<{ n: string; p: string }[]>`SELECT public.mask_name('Siti  Nur' || E'\t' || 'Rahmawati') AS n, public.mask_phone('+6281234567890') AS p`;
    expect(row).toMatchObject({ masked_name: "S*** N*** R***", masked_phone: "****890" });
    expect([row?.["masked_name"], row?.["masked_phone"]]).toEqual([rule?.n, rule?.p]);
  });

  it("names the landing page's primary host: its first registered domain, not the first in the alphabet", async () => {
    const order = await newOrder();
    expect((await status(order.publicId))[0]).toMatchObject({ lp_host: LP_HOST });
    expect(LP_HOST > `a-${LP_HOST}`).toBe(true);
  });

  it("gives a public_rw lateral dump over every public id only masked values: no raw name, phone or e-mail leaves the database", async () => {
    const people = [
      { name: "Adinda Kusuma", email: "adinda.kusuma@example.invalid" },
      { name: "Bagas Prasetyo Wijaya", email: "bagas.pw@example.invalid" },
      { name: "Citra", email: "citra@example.invalid" },
    ];
    const made = [];
    for (const person of people) made.push({ ...person, order: await newOrder("paid", { buyer_name: person.name, buyer_email: person.email }) });
    const dump = await asRole("public_rw", (tx) => tx<Record<string, string | null>[]>`
      SELECT g.* FROM public.orders o CROSS JOIN LATERAL public.get_order_status(o.public_id) g`);
    expect(dump.length).toBeGreaterThanOrEqual(people.length);
    const text = JSON.stringify(dump);
    for (const { name, email, order } of made) {
      for (const secret of [name, ...name.split(" "), email, email.split("@")[0] ?? "", order.phone, order.phone.slice(3)]) expect(text, secret).not.toContain(secret);
    }
    for (const row of dump) {
      expect(row["masked_name"], String(row["masked_name"])).toMatch(/^(\S\*\*\*)( \S\*\*\*)*$/);
      expect(row["masked_phone"], String(row["masked_phone"])).toMatch(/^\*\*\*\*\d{0,3}$/);
    }
  });

  it("returns nothing for an unknown or malformed id, and never raises", async () => {
    for (const id of ["", "x", "0".repeat(22), "' OR 1=1 --", "a".repeat(5000), "%"]) expect(await status(id), id.slice(0, 12)).toEqual([]);
  });

  it("is executable by public_rw only", async () => {
    const order = await newOrder();
    for (const role of ["admin_rw", "worker_rw"] as const) expect(await sqlState(status(order.publicId, role)), role).toBe("42501");
  });
});

describe("claim_browser_mt", () => {
  it("gives the claim only for a PAID order, once, with the pixel contract's values", async () => {
    const order = await newOrder("paid");
    const first1 = await claim(order.publicId);
    expect(first1).toEqual([{ order_id: order.id, event_id: order.eventId, amount_idr: "49000", pixels: PIXELS }]);
    expect(await firedAt(order.id)).toBeInstanceOf(Date);
    expect(await claim(order.publicId)).toEqual([]);
    expect(await claim(order.publicId)).toEqual([]);
  });

  it.each(["pending", "review", "expired", "gateway_failed", "snap_create_failed", "refunded"])("gives nothing for a %s order and leaves it unclaimed", async (state) => {
    const order = await newOrder(state);
    expect(await claim(order.publicId)).toEqual([]);
    expect(await firedAt(order.id)).toBeNull();
  });

  it("gives nothing for an unknown id", async () => {
    expect(await claim("A".repeat(22))).toEqual([]);
  });

  it("gives exactly one winner among concurrent claims (two tabs, a retry storm)", async () => {
    for (let round = 0; round < 3; round++) {
      const order = await newOrder("paid");
      const results = await Promise.all(Array.from({ length: 16 }, () => claim(order.publicId)));
      expect(results.filter((rows) => rows.length === 1), `round ${String(round)}`).toHaveLength(1);
      expect(results.filter((rows) => rows.length === 0)).toHaveLength(15);
    }
  });

  it("cannot be claimed before payment, and can once the order is paid", async () => {
    const order = await newOrder();
    expect(await claim(order.publicId)).toEqual([]);
    await sql`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
    expect(await claim(order.publicId)).toHaveLength(1);
  });

  it("is the only way public_rw can set browser_mt_fired_at: a direct UPDATE, even to clear it, is denied (42501)", async () => {
    const order = await newOrder("paid");
    expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.orders SET browser_mt_fired_at = now() WHERE id = ${order.id}`))).toBe("42501");
    await claim(order.publicId);
    expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.orders SET browser_mt_fired_at = NULL WHERE id = ${order.id}`))).toBe("42501");
    expect(await firedAt(order.id)).toBeInstanceOf(Date);
  });

  it("has no column privilege to write browser_mt_fired_at at all for public_rw (the grant is not back after a merge)", async () => {
    const rows = await sql<{ op: string; ok: boolean }[]>`
      SELECT op, has_column_privilege('public_rw', 'public.orders', 'browser_mt_fired_at', op) AS ok FROM unnest(ARRAY['UPDATE', 'INSERT']) op`;
    expect(rows).toEqual([
      { op: "UPDATE", ok: false },
      { op: "INSERT", ok: false },
    ]);
  });

  it("changes nothing else about the order, updated_at included (a claim is not a change of the order)", async () => {
    const order = await newOrder("paid");
    const read = async () =>
      first(await sql<{ status: string; paid_at: Date; amount: string; updated_at: Date }[]>`SELECT status::text, paid_at, amount_idr::text AS amount, updated_at FROM public.orders WHERE id = ${order.id}`);
    const before = await read();
    await claim(order.publicId);
    expect(await read()).toEqual(before);
  });

  it("is a bearer action that expires an hour after payment: an order paid longer ago is not claimable, and stays unclaimed", async () => {
    const stale = await newOrder("paid", {}, 61);
    expect(await claim(stale.publicId)).toEqual([]);
    expect(await firedAt(stale.id)).toBeNull();
    const fresh = await newOrder("paid", {}, 59);
    expect(await claim(fresh.publicId)).toHaveLength(1);
    // A paid order without a payment time (a data fault) is not claimable either.
    const odd = await newOrder("paid", {}, null);
    expect(await claim(odd.publicId)).toEqual([]);
  });

  it("waits for a refund that is committing and then gives nothing: the row lock is shared with the payment transitions (US-021)", async () => {
    const order = await newOrder("paid");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const refund = asRole("worker_rw", async (tx) => {
      await tx`SELECT id FROM public.orders WHERE id = ${order.id} FOR UPDATE`;
      locked();
      await held;
      await tx`UPDATE public.orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.id}`;
    });
    await lockTaken;
    const racing = claim(order.publicId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await refund;
    expect(await racing).toEqual([]);
    expect(await firedAt(order.id)).toBeNull();
  });

  it("is executable by public_rw only", async () => {
    const order = await newOrder("paid");
    for (const role of ["admin_rw", "worker_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT * FROM public.claim_browser_mt(${order.publicId})`)), role).toBe("42501");
    }
    expect(await firedAt(order.id)).toBeNull();
  });
});
