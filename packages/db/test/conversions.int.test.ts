// US-024: the DB side of exactly-once conversions and of the CAPI credentials. Every denial asserts the
// exact SQLSTATE: ET083 (a sent conversion is final), ET084 (the manual re-fire refuses what it must),
// ET080 (the MT of an unpaid order), 42501 (the console cannot write the conversion log),
// 23514 (the settings_secrets binding check), 23505 (one log row per attempt).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { conversionSecretStore, findCapiSecret } from "../src/secrets.ts";
import { asRole, bytes, first, rolledBack, sql, sqlState, suffix, type Tx } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

type Id = { id: string };

let base: { landingPageId: string; programId: string; productId: string };
beforeAll(async () => {
  const { productId, programId } = await createProgram();
  base = { landingPageId: await createLandingPage(programId), programId, productId };
});

const META_PIXEL = "1234567890123";
const TIKTOK_PIXEL = "C3ABCDEFGH0123456";

async function newOrder(status: string): Promise<string> {
  const row = orderRow(base);
  const order = first(await sql<Id[]>`INSERT INTO orders ${sql({ ...row, status: "pending" })} RETURNING id`);
  if (status !== "pending") await sql`UPDATE orders SET status = ${status}, paid_at = CASE WHEN ${status} = 'paid' THEN now() END WHERE id = ${order.id}`;
  return order.id;
}

async function newEvent(orderId: string, opts: { sink?: string; kind?: string; status?: string; lastError?: string | null; attempts?: number } = {}): Promise<string> {
  const status = opts.status ?? "pending";
  return first(
    await sql<Id[]>`
      INSERT INTO conversion_events (order_id, sink, kind, status, txid, event_id, attempts, last_error, failed_at, sent_at)
      VALUES (${orderId}, ${opts.sink ?? "meta"}, ${opts.kind ?? "mt"}, ${status}, ${orderId}, gen_random_uuid(), ${opts.attempts ?? 0}, ${opts.lastError ?? null},
              ${status === "failed" ? new Date() : null}, ${status === "sent" ? new Date() : null})
      RETURNING id`,
  ).id;
}

const stateOf = async (id: string) =>
  first(await sql<{ status: string; last_error: string | null; sent_at: Date | null; failed_at: Date | null; lease_until: Date | null; due: boolean }[]>`
    SELECT status::text AS status, last_error, sent_at, failed_at, lease_until, next_attempt_at <= clock_timestamp() AS due FROM conversion_events WHERE id = ${id}`);

describe("a sent conversion is final (ET083)", () => {
  it("no role, and not the superuser, can move a row out of sent: no retry, claim or sweep can send it twice", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "sent", attempts: 1 });
    for (const status of ["pending", "sending", "failed"]) {
      expect(await sqlState(sql`UPDATE conversion_events SET status = ${status} WHERE id = ${id}`)).toBe("ET083");
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.conversion_events SET status = ${status} WHERE id = ${id}`))).toBe("ET083");
      // The console cannot even try (42501, below): the guard is for the roles that can write.
      expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.conversion_events SET status = ${status} WHERE id = ${id}`))).toBe("42501");
    }
    expect((await stateOf(id)).status).toBe("sent");
  });

  it("still lets the log of a sent row change in other ways (a late 2xx re-recording the same state)", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "sent", attempts: 1 });
    await asRole("worker_rw", (tx) => tx`UPDATE public.conversion_events SET status = 'sent', last_http_status = 200 WHERE id = ${id}`);
  });
});

describe("refire_conversion: the explicit Owner action", () => {
  const refire = (tx: Pick<Tx, "unsafe">, id: string, resendSent?: boolean) =>
    resendSent === undefined ? tx.unsafe("SELECT public.refire_conversion($1::uuid)", [id]) : tx.unsafe("SELECT public.refire_conversion($1::uuid, $2::boolean)", [id, resendSent]);

  it("puts a failed row back to pending and due now, with its history cleared and its attempt count kept", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "failed", attempts: 6, lastError: "HTTP 500" });
    await asRole("admin_rw", (tx) => refire(tx, id));
    expect(await stateOf(id)).toEqual({ status: "pending", last_error: null, sent_at: null, failed_at: null, lease_until: null, due: true });
    expect(first(await sql<{ attempts: number }[]>`SELECT attempts FROM conversion_events WHERE id = ${id}`).attempts).toBe(6);
  });

  it("resends a sent row only when told to, and that is the one way out of sent", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "sent", attempts: 1 });
    expect(await sqlState(asRole("admin_rw", (tx) => refire(tx, id)))).toBe("ET084");
    expect(await sqlState(asRole("admin_rw", (tx) => refire(tx, id, false)))).toBe("ET084");
    expect((await stateOf(id)).status).toBe("sent");
    await asRole("admin_rw", (tx) => refire(tx, id, true));
    expect(await stateOf(id)).toMatchObject({ status: "pending", sent_at: null, due: true });
  });

  it("refuses a pending or sending row (the worker's), and an unknown id", async () => {
    const order = await newOrder("paid");
    for (const status of ["pending", "sending"]) {
      const id = await newEvent(order, { sink: status === "pending" ? "tiktok" : "meta", status });
      expect(await sqlState(asRole("admin_rw", (tx) => refire(tx, id)))).toBe("ET084");
    }
    expect(await sqlState(asRole("admin_rw", (tx) => refire(tx, "00000000-0000-4000-8000-000000000000")))).toBe("ET010");
  });

  it("re-fires a row payments took out of the send path (order_not_paid) once its order is paid NOW; not while it is not (ET080)", async () => {
    const paid = await newOrder("paid");
    const cancelled = await newEvent(paid, { status: "failed", lastError: "order_not_paid" });
    await asRole("admin_rw", (tx) => refire(tx, cancelled));
    expect(await stateOf(cancelled)).toMatchObject({ status: "pending", last_error: null });
    const review = await newOrder("paid");
    const stuck = await newEvent(review, { status: "failed", lastError: "order_not_paid" });
    await sql`UPDATE orders SET status = 'review' WHERE id = ${review}`;
    for (const resend of [undefined, true]) expect(await sqlState(asRole("admin_rw", (tx) => refire(tx, stuck, resend)))).toBe("ET080");
    expect((await stateOf(stuck)).status).toBe("failed");
  });

  it("never clears what the sink may have counted or the payout it reported", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "failed", lastError: "needs manual re-fire (the send may have counted): timeout", attempts: 1 });
    await sql`UPDATE conversion_events SET maybe_counted = true, reported_payout_idr = 15000 WHERE id = ${id}`;
    await asRole("admin_rw", (tx) => refire(tx, id));
    expect(first(await sql<{ maybe_counted: boolean; payout: string }[]>`SELECT maybe_counted, reported_payout_idr::text AS payout FROM conversion_events WHERE id = ${id}`)).toEqual({ maybe_counted: true, payout: "15000" });
  });

  it("cannot put the MT of an order that is not paid back into the send path (ET080), whoever asks", async () => {
    for (const status of ["refunded", "review"]) {
      const order = await newOrder("paid");
      const id = await newEvent(order, { status: "failed", lastError: "HTTP 500" });
      await sql`UPDATE orders SET status = ${status}, refunded_at = CASE WHEN ${status} = 'refunded' THEN now() END WHERE id = ${order}`;
      expect(await sqlState(asRole("admin_rw", (tx) => refire(tx, id)))).toBe("ET080");
      expect((await stateOf(id)).status).toBe("failed");
    }
  });

  it("runs as conversion_refire: the role has no other write on a conversion, and the console no write at all", async () => {
    const id = await newEvent(await newOrder("paid"), { status: "failed", attempts: 2 });
    await rolledBack(null, async (tx) => {
      await tx.unsafe("SET LOCAL ROLE conversion_refire");
      expect(await sqlState(tx.unsafe("UPDATE public.conversion_events SET attempts = 0 WHERE id = $1", [id]))).toBe("42501");
    });
    await rolledBack(null, async (tx) => {
      await tx.unsafe("SET LOCAL ROLE conversion_refire");
      expect(await sqlState(tx.unsafe("UPDATE public.conversion_events SET maybe_counted = false WHERE id = $1", [id]))).toBe("42501");
    });
    await rolledBack(null, async (tx) => {
      await tx.unsafe("SET LOCAL ROLE conversion_refire");
      expect(await sqlState(tx.unsafe("INSERT INTO public.conversion_attempts (conversion_event_id, attempt) VALUES ($1, 9)", [id]))).toBe("42501");
    });
  });

  it("is executable by admin_rw only", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "failed" });
    for (const role of ["public_rw", "worker_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => refire(tx, id)))).toBe("42501");
    }
  });
});

describe("the console reads the conversion log and writes none of it (security review US-024 M1)", () => {
  it("admin_rw cannot INSERT, UPDATE or DELETE conversion_events or conversion_attempts (42501), but can SELECT them", async () => {
    const order = await newOrder("paid");
    const id = await newEvent(order, { status: "failed" });
    await sql`INSERT INTO conversion_attempts (conversion_event_id, attempt) VALUES (${id}, 1)`;
    const statements = [
      "INSERT INTO public.conversion_events (order_id, sink, kind, txid, event_id) VALUES ($1::uuid, 'tiktok', 'mt', $1::text, gen_random_uuid())",
      "UPDATE public.conversion_events SET status = 'pending' WHERE order_id = $1::uuid",
      "UPDATE public.conversion_events SET maybe_counted = true WHERE order_id = $1::uuid",
      "DELETE FROM public.conversion_events WHERE order_id = $1::uuid",
      "INSERT INTO public.conversion_attempts (conversion_event_id, attempt) SELECT id, 5 FROM public.conversion_events WHERE order_id = $1::uuid",
      "UPDATE public.conversion_attempts SET http_status = 200 WHERE conversion_event_id IN (SELECT id FROM public.conversion_events WHERE order_id = $1::uuid)",
      "DELETE FROM public.conversion_attempts WHERE conversion_event_id IN (SELECT id FROM public.conversion_events WHERE order_id = $1::uuid)",
    ];
    for (const statement of statements) expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement, [order]))), statement).toBe("42501");
    await asRole("admin_rw", async (tx) => {
      expect(await tx`SELECT id FROM public.conversion_events WHERE order_id = ${order}`).toHaveLength(1);
      expect(await tx`SELECT attempt FROM public.conversion_attempts WHERE conversion_event_id = ${id}`).toHaveLength(1);
    });
  });
});

describe("the source of an order for the reports (criterion 3: Organic, AC-T8: no click id)", () => {
  it("labels an order with no click id Organic, also when it kept its adnet, and an attributed one with the adnet's name", async () => {
    const adnet = first(await sql<Id[]>`INSERT INTO adnets (slug, name, clickid_param) VALUES (${`s-${suffix()}`}, 'Adnet Biru', 'cid') RETURNING id`).id;
    try {
      const row = orderRow(base);
      const attributed = first(await sql<Id[]>`INSERT INTO orders ${sql({ ...row, status: "pending", adnet_id: adnet, clickid: "c1" })} RETURNING id`).id;
      const organic = await newOrder("pending");
      // The checkout keeps the adnet of an order whose click id was dropped: it has an adnet and no click id.
      const noClick = first(await sql<Id[]>`INSERT INTO orders ${sql({ ...orderRow(base), status: "pending", adnet_id: adnet })} RETURNING id`).id;
      const labels = await asRole("admin_rw", (tx) =>
        tx<{ id: string; source: string }[]>`SELECT id, public.order_source_label(adnet_id, clickid) AS source FROM public.orders WHERE id IN (${attributed}, ${organic}, ${noClick})`,
      );
      expect(Object.fromEntries(labels.map((l) => [l.id, l.source]))).toEqual({ [attributed]: "Adnet Biru", [organic]: "Organic", [noClick]: "Organic" });
      expect(first(await sql<{ labels: string[] }[]>`SELECT ARRAY[public.order_source_label(NULL, NULL), public.order_source_label(${adnet}, ''), public.order_source_label(NULL, 'c1')] AS labels`).labels).toEqual(["Organic", "Organic", "Organic"]);
    } finally {
      await sql`DELETE FROM orders WHERE adnet_id = ${adnet}`;
      await sql`DELETE FROM adnets WHERE id = ${adnet}`;
    }
  });

  it("is executable by admin_rw only", async () => {
    for (const role of ["public_rw", "worker_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.order_source_label(NULL, NULL)`))).toBe("42501");
    }
  });
});

describe("conversion_attempts: one log row per attempt, up to 4 KB of the answer", () => {
  it("refuses a second row for the same attempt number of an event (23505)", async () => {
    const id = await newEvent(await newOrder("paid"));
    await sql`INSERT INTO conversion_attempts (conversion_event_id, attempt, http_status) VALUES (${id}, 1, 200)`;
    expect(await sqlState(sql`INSERT INTO conversion_attempts (conversion_event_id, attempt, http_status) VALUES (${id}, 1, 500)`)).toBe("23505");
    await sql`INSERT INTO conversion_attempts (conversion_event_id, attempt, http_status) VALUES (${id}, 2, 200)`;
  });

  it("keeps 4096 characters of the answer and refuses 4097 (23514)", async () => {
    const id = await newEvent(await newOrder("paid"));
    await sql`INSERT INTO conversion_attempts (conversion_event_id, attempt, response_excerpt) VALUES (${id}, 1, ${"x".repeat(4096)})`;
    expect(await sqlState(sql`INSERT INTO conversion_attempts (conversion_event_id, attempt, response_excerpt) VALUES (${id}, 2, ${"x".repeat(4097)})`)).toBe("23514");
  });
});

describe("CAPI access tokens: conversions secrets with no adnet, bound to the platform's host", () => {
  const created: string[] = [];
  afterEach(async () => {
    await sql`DELETE FROM settings_secrets WHERE id = ANY (${created}::uuid[])`;
    created.length = 0;
  });

  async function insertSecret(row: { scope?: string; name: string; adnet?: string | null; host: string | null }): Promise<string> {
    const id = await asRole("admin_rw", async (tx) =>
      first(
        await tx<Id[]>`
          INSERT INTO public.settings_secrets (scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
          VALUES (${row.scope ?? "conversions"}, ${row.name}, ${row.adnet ?? null}, ${row.host}, ${bytes(40)}, ${bytes(12)}, ${bytes(80)}, ${`${suffix()}${suffix()}`}, '1234')
          RETURNING id`,
      ).id,
    );
    created.push(id);
    return id;
  }

  it("accepts capi.meta.<pixel id> on graph.facebook.com and capi.tiktok.<pixel code> on business-api.tiktok.com", async () => {
    await insertSecret({ name: `capi.meta.${META_PIXEL}`, host: "graph.facebook.com" });
    await insertSecret({ name: `capi.tiktok.${TIKTOK_PIXEL.toLowerCase()}`, host: "business-api.tiktok.com" });
  });

  it.each([
    ["Meta token on another host", "capi.meta.1234567890123", "evil.example"],
    ["TikTok token on Meta's host", "capi.tiktok.c3abcdefgh0123456", "graph.facebook.com"],
    ["a name that is not a pixel id", "capi.meta.not-a-pixel", "graph.facebook.com"],
    ["an uppercase TikTok code (the name is lowercase)", "capi.tiktok.C3ABCDEFGH0123456", "business-api.tiktok.com"],
    ["any other conversions name without an adnet", "api_key", "graph.facebook.com"],
    ["a conversions secret with no host", "capi.meta.1234567890123", null],
  ])("refuses %s (23514)", async (_what, name, host) => {
    expect(await sqlState(insertSecret({ name, host }))).toBe("23514");
  });

  it("still refuses a payment or messaging secret that carries an adnet, and a CAPI name outside conversions", async () => {
    const adnet = first(await sql<Id[]>`INSERT INTO adnets (slug, name, clickid_param, endpoint_host) VALUES (${`a-${suffix()}`}, 'A', 'cid', 'track.example') RETURNING id`).id;
    try {
      expect(await sqlState(insertSecret({ scope: "payment", name: "payment.x", adnet, host: null }))).toBe("23514");
      expect(await sqlState(insertSecret({ scope: "messaging", name: `capi.meta.${META_PIXEL}`, adnet, host: "graph.facebook.com" }))).toBe("23514");
      await insertSecret({ scope: "messaging", name: "smtp.other", host: "smtp.example" });
    } finally {
      await sql`DELETE FROM adnets WHERE id = ${adnet}`;
    }
  });

  it("findCapiSecret returns the pixel's own token only, and an adnet's {secret:name} resolver never reads it", async () => {
    const adnet = first(await sql<Id[]>`INSERT INTO adnets (slug, name, clickid_param, endpoint_host) VALUES (${`a-${suffix()}`}, 'A', 'cid', 'graph.facebook.com') RETURNING id`).id;
    try {
      const name = `capi.meta.${META_PIXEL}`;
      const id = await insertSecret({ name, host: "graph.facebook.com" });
      expect(await findCapiSecret(sql, { name, host: "graph.facebook.com" })).toMatchObject({ id, scope: "conversions", name, adnetId: null, boundHost: "graph.facebook.com" });
      expect(await findCapiSecret(sql, { name, host: "business-api.tiktok.com" })).toBeUndefined();
      expect(await findCapiSecret(sql, { name: "capi.meta.9999999999", host: "graph.facebook.com" })).toBeUndefined();
      // An adnet whose endpoint host happens to be graph.facebook.com still cannot resolve {secret:capi.meta.<pixel>}.
      expect(await conversionSecretStore(sql).findConversionSecrets({ adnetId: adnet, host: "graph.facebook.com", names: [name] })).toEqual([]);
    } finally {
      await sql`DELETE FROM adnets WHERE id = ${adnet}`;
    }
  });

  it("admin_rw writes a token but cannot read it back (no SELECT on the sealed columns)", async () => {
    const id = await insertSecret({ name: `capi.meta.${META_PIXEL}`, host: "graph.facebook.com" });
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT ciphertext FROM public.settings_secrets WHERE id = ${id}`))).toBe("42501");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT sealed_dek FROM public.settings_secrets WHERE id = ${id}`))).toBe("42501");
    await asRole("admin_rw", (tx) => tx`SELECT id, name, last4 FROM public.settings_secrets WHERE id = ${id}`);
  });
});
