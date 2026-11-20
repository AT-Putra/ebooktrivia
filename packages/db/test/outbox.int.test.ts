// enqueue_notification / enqueue_waha_inbound / enqueue_mo: targets derived from DB rows,
// idempotent, and the only way public_rw reaches the outbox.
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState, suffix } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

const outboxRows = (dedupeKey: string) =>
  sql<{ id: string; topic: string; payload: Record<string, string> }[]>`
    SELECT id, topic, payload FROM outbox WHERE dedupe_key = ${dedupeKey}`;

const call = (fn: "enqueue_notification" | "enqueue_waha_inbound" | "enqueue_mo", id: string) =>
  asRole("public_rw", async (tx) => first(await tx<{ id: string }[]>`SELECT ${tx(fn)}(${id}) AS id`).id);

describe("enqueue_notification", () => {
  it("stores the inbox row once (ON CONFLICT DO NOTHING) and enqueues it once", async () => {
    const notification = {
      midtrans_order_id: `${suffix()}${suffix()}-1`,
      transaction_status: "settlement",
      status_code: "200",
      signature: suffix(),
      raw: sql.json({ order_id: "x" }),
    };
    const inboxId = await asRole("public_rw", async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO public.payment_notifications ${tx(notification)} ON CONFLICT DO NOTHING RETURNING id`;
      const replay = await tx`
        INSERT INTO public.payment_notifications ${tx(notification)} ON CONFLICT DO NOTHING RETURNING id`;
      expect(replay).toEqual([]);
      return first(inserted).id;
    });

    const a = await call("enqueue_notification", inboxId);
    const b = await call("enqueue_notification", inboxId);
    expect(b).toBe(a);
    const rows = await outboxRows(`payment.notification:${inboxId}`);
    expect(rows).toEqual([
      {
        id: a,
        topic: "payment.notification",
        payload: { inbox_id: inboxId, midtrans_order_id: notification.midtrans_order_id },
      },
    ]);
    const [marker] = await sql<{ outbox_id: string }[]>`SELECT outbox_id FROM payment_notifications WHERE id = ${inboxId}`;
    expect(marker?.outbox_id).toBe(a);
  });

  it("rejects an unknown inbox id (ET010)", async () => {
    expect(await sqlState(call("enqueue_notification", "00000000-0000-4000-8000-000000000000"))).toBe("ET010");
  });
});

describe("enqueue_waha_inbound", () => {
  it("enqueues an inbound message once, derived from its row", async () => {
    const messageId = `false_${suffix()}@c.us_${suffix()}`;
    const inboundId = await asRole("public_rw", async (tx) =>
      first(
        await tx<{ id: string }[]>`
          INSERT INTO public.waha_inbound (message_id, session_name, from_jid, body, raw)
          VALUES (${messageId}, 'default', '6281234567890@c.us', 'KODE 7ZK4M2QH9R', ${sql.json({})})
          RETURNING id`,
      ).id,
    );
    const a = await call("enqueue_waha_inbound", inboundId);
    expect(await call("enqueue_waha_inbound", inboundId)).toBe(a);
    expect(await outboxRows(`waha.inbound:${inboundId}`)).toEqual([
      { id: a, topic: "waha.inbound", payload: { inbound_id: inboundId, message_id: messageId } },
    ]);
  });

  it("rejects an unknown inbound id (ET010)", async () => {
    expect(await sqlState(call("enqueue_waha_inbound", "00000000-0000-4000-8000-000000000000"))).toBe("ET010");
  });
});

describe("enqueue_mo", () => {
  let base: { landingPageId: string; programId: string; productId: string };
  beforeAll(async () => {
    const { productId, programId } = await createProgram();
    base = { landingPageId: await createLandingPage(programId), programId, productId };
  });

  const insertOrder = () =>
    asRole("public_rw", async (tx) => first(await tx<{ id: string }[]>`INSERT INTO public.orders ${tx(orderRow(base))} RETURNING id`).id);

  it("refuses an order whose Snap redirect URL is not stored yet (ET011)", async () => {
    const orderId = await insertOrder();
    expect(await sqlState(call("enqueue_mo", orderId))).toBe("ET011");
  });

  it("enqueues MO once per order after Snap succeeded", async () => {
    const orderId = await insertOrder();
    await asRole(
      "public_rw",
      (tx) => tx`UPDATE public.orders SET snap_redirect_url = 'https://app.sandbox.midtrans.com/snap/v4/redirection/x'
                 WHERE id = ${orderId}`,
    );
    const a = await call("enqueue_mo", orderId);
    expect(await call("enqueue_mo", orderId)).toBe(a);
    expect(await outboxRows(`conversion.mo:${orderId}`)).toEqual([
      { id: a, topic: "conversion.mo", payload: { order_id: orderId } },
    ]);
    expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.orders SET mo_outbox_id = NULL WHERE id = ${orderId}`))).toBe(
      "42501",
    );
  });

  it("enqueues ONE MO when many transactions race for the same order (US-020: replay or race never doubles it)", async () => {
    const orderId = await insertOrder();
    await asRole("public_rw", (tx) => tx`UPDATE public.orders SET snap_redirect_url = 'https://app.sandbox.midtrans.com/snap/v4/redirection/y' WHERE id = ${orderId}`);
    const ids = await Promise.all(Array.from({ length: 8 }, () => call("enqueue_mo", orderId)));
    expect(new Set(ids).size).toBe(1);
    expect(await outboxRows(`conversion.mo:${orderId}`)).toHaveLength(1);
  });

  it("rejects an unknown order id (ET010)", async () => {
    expect(await sqlState(call("enqueue_mo", "00000000-0000-4000-8000-000000000000"))).toBe("ET010");
  });
});
