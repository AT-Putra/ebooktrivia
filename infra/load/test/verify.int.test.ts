// The AC-P8 verifier against the real schema, with the REAL paid-effects SQL (public.order_paid_effects, the one function
// the worker runs when an order is paid): a clean run passes, and each identity is broken in turn and must fail by name.
import { createHash } from "node:crypto";
import { newOrderCode, newPublicId } from "@ebooktrivia/core";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newRunId, seedOrders } from "../src/seed-lib.ts";
import { type Report, verifyAcP8 } from "../src/verify-p8.ts";

const sql = postgres(inject("loadDbUrl"), { max: 4, onnotice: () => undefined });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

interface Run {
  readonly lpKey: string;
  readonly lpId: string;
  readonly programId: string;
  readonly adnetId: string;
  readonly orderIds: string[];
}

/**
 * `paid` paid orders (all attributed) and `unpaid` pending ones, as the checkout and the worker would leave them once drained.
 * With `into`, the orders go to that run's landing page (a trial before the real run, or the real run after a trial).
 */
async function makeRun(paid: number, unpaid: number, mt: "sent" | "failed" | "pending" = "sent", into?: Run): Promise<Run> {
  const runId = newRunId();
  const config =
    into === undefined
      ? await seedOrders(sql, { runId, lpHost: `lt-${runId}.example.test`, postbackUrl: "https://sink.example.test/postback", priceIdr: 10_000 })
      : { lp_key: into.lpKey, landing_page_id: into.lpId, program_id: into.programId, adnet_id: into.adnetId };
  const orderIds: string[] = [];
  for (let i = 0; i < paid + unpaid; i++) {
    const tag = `${runId}${String(i).padStart(4, "0")}`;
    const [order] = await sql<{ id: string }[]>`
      INSERT INTO public.orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at,
                                 adnet_id, clickid, snap_redirect_url)
      SELECT ${newPublicId()}, ${newOrderCode()}, ${config.landing_page_id}, ${config.program_id}, p.product_id, 'Budi', ${`+628120${String(10_000 + i)}`},
             'budi@example.test', ${createHash("sha256").update(tag).digest()}, 10000, 'pending', now() + interval '1 hour', ${config.adnet_id}, ${`click${tag}`},
             'https://app.sandbox.midtrans.com/snap/v4/redirection/00000000-0000-4000-8000-000000000000'
        FROM public.programs p WHERE p.id = ${config.program_id}
      RETURNING id`;
    const id = order?.id ?? "";
    orderIds.push(id);
    // MO: what enqueue_mo and the MO consumer leave behind (one s2s row, sent after a 2xx).
    const [mo] = await sql<{ id: string }[]>`SELECT public.enqueue_mo(${id}) AS id`;
    await sql`UPDATE public.outbox SET processed_at = now(), relayed_at = now() WHERE id = ${mo?.id ?? ""}`;
    const [moRow] = await sql<{ id: string }[]>`
      INSERT INTO public.conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, sent_at, maybe_counted)
      SELECT o.id, 's2s', 'mo', 'sent', o.adnet_id, o.id::text, o.event_id, 10000, now(), true FROM public.orders o WHERE o.id = ${id} RETURNING id`;
    await sql`INSERT INTO public.conversion_attempts (conversion_event_id, attempt, http_status, latency_ms) VALUES (${moRow?.id ?? ""}, 1, 200, 30)`;
    if (i >= paid) continue;
    await sql`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${id}`;
    await sql`SELECT public.order_paid_effects(${id}, now(), 180000)`;
    // The worker's side: MT sent (one 2xx), e-mail sent, order.paid consumed.
    if (mt === "sent") {
      const [row] = await sql<{ id: string }[]>`UPDATE public.conversion_events SET status = 'sent', sent_at = now(), maybe_counted = true WHERE order_id = ${id} AND kind = 'mt' AND sink = 's2s' RETURNING id`;
      await sql`INSERT INTO public.conversion_attempts (conversion_event_id, attempt, http_status, latency_ms) VALUES (${row?.id ?? ""}, 1, 200, 40)`;
    } else if (mt === "failed") {
      await sql`UPDATE public.conversion_events SET status = 'failed', failed_at = now(), last_error = 'http_500' WHERE order_id = ${id} AND kind = 'mt' AND sink = 's2s'`;
    }
    await sql`UPDATE public.deliveries SET status = 'sent', sent_at = now() WHERE order_id = ${id} AND channel = 'email'`;
    await sql`UPDATE public.outbox SET processed_at = now(), relayed_at = now() WHERE dedupe_key = ${`order.paid:${id}`}`;
  }
  return { lpKey: config.lp_key, lpId: config.landing_page_id, programId: config.program_id, adnetId: config.adnet_id, orderIds };
}

const failing = (report: Report): string[] => report.checks.filter((c) => !c.ok).map((c) => c.name.split(" ")[0] ?? "");

describe("verifyAcP8", () => {
  it("holds on a clean run: the real paid effects, every MT sent once, nothing open", async () => {
    const run = await makeRun(5, 2);
    const report = await verifyAcP8(sql, { lpKey: run.lpKey, expectedOrders: 7, requireEmailSent: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.numbers).toMatchObject({ orders_total: 7, orders_with_redirect_url: 7, orders_paid: 5 });
    expect(report.per_adnet).toEqual([expect.objectContaining({ paid_with_clickid: 5, mt_sent: 5, mt_failed: 0, mt_open: 0 })]);
  });

  it("fails identity 1 when k6 counted more orders than the database holds (a lost order)", async () => {
    const run = await makeRun(2, 0);
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey, expectedOrders: 3 }))).toEqual(["1"]);
  });

  it("fails identity 1b for a pending order that never got its Snap URL", async () => {
    const run = await makeRun(1, 1);
    await sql`UPDATE public.orders SET snap_redirect_url = NULL, mo_outbox_id = NULL, created_at = now() - interval '5 minutes' WHERE id = ${run.orderIds[1] ?? ""}`;
    const report = await verifyAcP8(sql, { lpKey: run.lpKey });
    expect(failing(report)).toContain("1b");
  });

  it("fails identity 2 when an order with a URL has no MO outbox row, and 2b when an MO conversion row is missing", async () => {
    const run = await makeRun(2, 0);
    await sql`UPDATE public.orders SET mo_outbox_id = NULL WHERE id = ${run.orderIds[0] ?? ""}`;
    await sql`DELETE FROM public.conversion_attempts WHERE conversion_event_id IN (SELECT id FROM public.conversion_events WHERE order_id = ${run.orderIds[1] ?? ""} AND kind = 'mo')`;
    await sql`DELETE FROM public.conversion_events WHERE order_id = ${run.orderIds[1] ?? ""} AND kind = 'mo'`;
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["2", "2b"]);
  });

  it("fails identity 3 when a PAID order has lost its e-mail delivery row, and 3c when its order.paid outbox row is gone", async () => {
    const run = await makeRun(3, 0);
    await sql`ALTER TABLE public.deliveries DISABLE TRIGGER USER`;
    try {
      await sql`DELETE FROM public.deliveries WHERE order_id = ${run.orderIds[0] ?? ""} AND channel = 'email'`;
    } finally {
      await sql`ALTER TABLE public.deliveries ENABLE TRIGGER USER`;
    }
    await sql`DELETE FROM public.outbox WHERE dedupe_key = ${`order.paid:${run.orderIds[1] ?? ""}`}`;
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["3", "3c"]);
  });

  it("fails identity 3d for a delivery stuck in sending with an expired lease", async () => {
    const run = await makeRun(2, 0);
    await sql`UPDATE public.deliveries SET status = 'sending', lease_until = now() - interval '10 minutes', sent_at = NULL WHERE order_id = ${run.orderIds[0] ?? ""} AND channel = 'whatsapp'`;
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["3d"]);
  });

  it("fails identity 4 when a PAID order has no MT row (a lost MT), counting failed rows as accounted for", async () => {
    const run = await makeRun(3, 0);
    await sql`DELETE FROM public.conversion_attempts WHERE conversion_event_id IN (SELECT id FROM public.conversion_events WHERE order_id = ${run.orderIds[0] ?? ""} AND kind = 'mt')`;
    await sql`DELETE FROM public.conversion_events WHERE order_id = ${run.orderIds[0] ?? ""} AND kind = 'mt'`;
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["4"]);
    // A visibly FAILED MT still balances the identity (sent + failed).
    const ok = await makeRun(2, 0, "failed");
    expect((await verifyAcP8(sql, { lpKey: ok.lpKey })).ok).toBe(true);
  });

  it("fails identity 4b for a live MT row of an unpaid order", async () => {
    const run = await makeRun(2, 0);
    await sql`ALTER TABLE public.orders DISABLE TRIGGER USER`;
    try {
      await sql`UPDATE public.orders SET status = 'pending' WHERE id = ${run.orderIds[0] ?? ""}`;
    } finally {
      await sql`ALTER TABLE public.orders ENABLE TRIGGER USER`;
    }
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toContain("4b");
  });

  it("fails identity 5b when an MT postback was answered 2xx twice (the duplicate the AC is about)", async () => {
    const run = await makeRun(2, 0);
    const [mt] = await sql<{ id: string }[]>`SELECT id FROM public.conversion_events WHERE order_id = ${run.orderIds[0] ?? ""} AND kind = 'mt'`;
    await sql`INSERT INTO public.conversion_attempts (conversion_event_id, attempt, http_status, latency_ms) VALUES (${mt?.id ?? ""}, 2, 200, 55)`;
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["5b"]);
  });

  it("fails identity 6 while work is open, and passes once the worker finished it during the wait", async () => {
    const run = await makeRun(2, 0, "pending");
    // An MT still pending is neither sent nor failed yet: identity 4 cannot balance until the worker is done.
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["4", "6"]);
    let slept = 0;
    const report = await verifyAcP8(sql, {
      lpKey: run.lpKey,
      waitSeconds: 60,
      sleep: async () => {
        slept++;
        await sql`UPDATE public.conversion_events SET status = 'sent', sent_at = now() WHERE order_id IN ${sql(run.orderIds)} AND kind = 'mt' AND status = 'pending'`;
      },
    });
    expect(slept).toBe(1);
    expect(report.ok).toBe(true);
  });

  it("only demands e-mails to be sent with --require-email-sent", async () => {
    const run = await makeRun(2, 0);
    await sql`UPDATE public.deliveries SET status = 'failed', last_error = 'smtp_down' WHERE order_id = ${run.orderIds[0] ?? ""} AND channel = 'email'`;
    expect((await verifyAcP8(sql, { lpKey: run.lpKey })).ok).toBe(true);
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey, requireEmailSent: true }))).toEqual(["6b"]);
  });

  // Review item 2: WhatsApp is off for the run, so nothing of the run may have been sent to a (synthetic, real-looking) number.
  it("fails identity 7 when a WhatsApp delivery of the run is sent: a stranger was messaged", async () => {
    const run = await makeRun(2, 0);
    expect((await verifyAcP8(sql, { lpKey: run.lpKey })).ok).toBe(true);
    await sql`UPDATE public.deliveries SET status = 'sent', sent_at = now() WHERE order_id = ${run.orderIds[0] ?? ""} AND channel = 'whatsapp'`;
    expect(failing(await verifyAcP8(sql, { lpKey: run.lpKey }))).toEqual(["7"]);
  });

  // Review item 6 (procedure B): the 5-order trial is on the same landing page as the real run; only the run's own orders count.
  it("counts only the orders created from `since`: a trial before the run cannot cause a false FAIL, and a loss inside the run still fails", async () => {
    const trial = await makeRun(2, 0);
    await sql`UPDATE public.orders SET created_at = now() - interval '1 hour' WHERE landing_page_id = ${trial.lpId}`;
    const since = new Date(Date.now() - 30 * 60_000);
    await makeRun(3, 0, "sent", trial);
    // Without the run's start the trial's 2 orders are counted: k6 made 3, the landing page holds 5.
    expect(failing(await verifyAcP8(sql, { lpKey: trial.lpKey, expectedOrders: 3 }))).toContain("1");
    const own = await verifyAcP8(sql, { lpKey: trial.lpKey, expectedOrders: 3, since });
    expect(own.checks.filter((c) => !c.ok)).toEqual([]);
    expect(own.numbers).toMatchObject({ orders_total: 3, orders_paid: 3 });
    // A real loss in the run (k6 made 4, the database holds 3) still fails, trial or not.
    expect(failing(await verifyAcP8(sql, { lpKey: trial.lpKey, expectedOrders: 4, since }))).toEqual(["1"]);
  });

  it("refuses an unknown landing page", async () => {
    await expect(verifyAcP8(sql, { lpKey: "lp_doesnotexist1" })).rejects.toThrow(/no landing page/);
  });
});
