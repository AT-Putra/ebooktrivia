// US-025 / US-029 (AC-A1: Staff may manage resends): the console's resend of a delivery, as the admin_rw login through public.resend_delivery, audited in
// the same transaction. A failed delivery goes back on the send path; an unknown one (a send that MAY have reached the buyer) only with the explicit
// confirmation, and the policy keeps that to the Owner; nothing the console does can move a delivery any other way.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "../src/lib/policy.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { resendDelivery } from "../src/lib/settings/deliveries.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

const rt = newRuntime();
let staffId = "";
let ownerId = "";
let shopIds: { productId: string; programId: string; landingPageId: string };

beforeAll(async () => {
  staffId = (await createTestAdmin(rt, "staff")).userId;
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  const [product] = await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`;
  const [program] = await root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${`rs-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`;
  const [lp] = await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program?.id ?? ""}) RETURNING id`;
  shopIds = { productId: product?.id ?? "", programId: program?.id ?? "", landingPageId: lp?.id ?? "" };
});
afterAll(async () => {
  await root`UPDATE deliveries SET status = 'cancelled' WHERE status = 'pending' AND order_id IN (SELECT id FROM orders WHERE landing_page_id = ${shopIds.landingPageId})`;
});

async function delivery(opts: { status: string; channel?: "email" | "whatsapp"; lastError?: string | null; orderStatus?: string }) {
  const [order] = await root<{ id: string }[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, expires_at)
    VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`${suffix()}${suffix()}`.toUpperCase()}, ${shopIds.landingPageId}, ${shopIds.programId}, ${shopIds.productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid',
            sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, now() + interval '1 day') RETURNING id`;
  await root`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order?.id ?? ""}`;
  const [row] = await root<{ id: string }[]>`
    INSERT INTO deliveries (order_id, channel, status, attempts, last_error) VALUES (${order?.id ?? ""}, ${opts.channel ?? "email"}, ${opts.status}, 3, ${opts.lastError ?? null}) RETURNING id`;
  if (opts.orderStatus !== undefined && opts.orderStatus !== "paid") await root`UPDATE orders SET status = ${opts.orderStatus}, refunded_at = now() WHERE id = ${order?.id ?? ""}`;
  return { orderId: order?.id ?? "", id: row?.id ?? "" };
}
const state = async (id: string) => (await root<{ status: string; attempts: number; attempts_base: number; last_error: string | null }[]>`SELECT status::text AS status, attempts, attempts_base, last_error FROM deliveries WHERE id = ${id}`)[0];
const audits = (id: string) => root<{ actor_kind: string; actor_admin_user_id: string | null; changes: Record<string, unknown> }[]>`SELECT actor_kind, actor_admin_user_id, changes FROM audit_log WHERE action = 'delivery.resend' AND entity_id = ${id}`;

describe("who may resend what (AC-A1)", () => {
  it("Staff may resend a failed delivery; only the Owner may resend one that may already have reached the buyer", () => {
    expect(can("staff", "delivery.resend")).toBe(true);
    expect(can("owner", "delivery.resend")).toBe(true);
    expect(can("staff", "delivery.resend_unknown")).toBe(false);
    expect(can("owner", "delivery.resend_unknown")).toBe(true);
  });
});

describe("resend of a failed delivery", () => {
  it("puts it back to pending, due now, with its tries cleared, and writes the audit entry in the same transaction (the error only as a code)", async () => {
    const { id, orderId } = await delivery({ status: "failed", lastError: "smtp_rejected" });
    await asAdmin(staffId, () => resendDelivery(rt.sql, id));
    // `attempts` is never reset (a stale finisher of an old claim must not be able to record onto a new one): the retry budget starts again by moving attempts_base.
    expect(await state(id)).toEqual({ status: "pending", attempts: 3, attempts_base: 3, last_error: null });
    const [audit] = await audits(id);
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: staffId });
    expect(audit?.changes).toMatchObject({ status: { before: "failed", after: "pending" }, channel: "email", order_id: orderId, attempts: 3, error_code: "smtp_rejected", confirmed_unknown: false });
  });

  it("records a stored text as `other`, never the text", async () => {
    const { id } = await delivery({ status: "failed", lastError: "rejected: buyer@example.invalid +6281234567890" });
    await asAdmin(ownerId, () => resendDelivery(rt.sql, id));
    const [audit] = await audits(id);
    expect(audit?.changes).toMatchObject({ error_code: "other" });
    expect(JSON.stringify(audit?.changes)).not.toContain("buyer@example.invalid");
    expect(JSON.stringify(audit?.changes)).not.toContain("+6281234567890");
  });

  it("a WhatsApp delivery is resent the same way (the ebook goes out when the buyer writes; its opener is untouched)", async () => {
    const { id } = await delivery({ status: "failed", channel: "whatsapp", lastError: "waha_rejected" });
    await root`INSERT INTO delivery_openers (delivery_id, status, attempts) VALUES (${id}, 'sent', 1)`;
    await asAdmin(staffId, () => resendDelivery(rt.sql, id));
    expect((await state(id))?.status).toBe("pending");
    expect((await root<{ status: string }[]>`SELECT status FROM delivery_openers WHERE delivery_id = ${id}`)[0]?.status).toBe("sent");
  });
});

describe("resend of an unknown delivery (a send that may have gone out)", () => {
  it("is refused without the explicit confirmation: nothing changes and nothing is audited", async () => {
    const { id } = await delivery({ status: "unknown", lastError: "smtp_maybe_sent" });
    await expect(asAdmin(staffId, () => resendDelivery(rt.sql, id))).rejects.toThrow(/may already have reached the buyer/);
    await expect(asAdmin(ownerId, () => resendDelivery(rt.sql, id, { confirmUnknown: false }))).rejects.toThrow(InvalidInput);
    expect((await state(id))?.status).toBe("unknown");
    expect(await audits(id)).toEqual([]);
  });

  it("is refused while its lease has not ended (a send may still be running), even with the confirmation; nothing is audited", async () => {
    const { id } = await delivery({ status: "unknown", lastError: "smtp_maybe_sent" });
    await root`UPDATE deliveries SET lease_until = now() + interval '2 minutes' WHERE id = ${id}`;
    await expect(asAdmin(ownerId, () => resendDelivery(rt.sql, id, { confirmUnknown: true }))).rejects.toThrow(/may still be running/);
    expect((await state(id))?.status).toBe("unknown");
    expect(await audits(id)).toEqual([]);
    await root`UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = ${id}`;
    await asAdmin(ownerId, () => resendDelivery(rt.sql, id, { confirmUnknown: true }));
    expect((await state(id))?.status).toBe("pending");
  });

  it("is resent with the confirmation, and the audit entry says it was confirmed", async () => {
    const { id } = await delivery({ status: "unknown", lastError: "smtp_maybe_sent" });
    await asAdmin(ownerId, () => resendDelivery(rt.sql, id, { confirmUnknown: true }));
    expect((await state(id))?.status).toBe("pending");
    const [audit] = await audits(id);
    expect(audit?.changes).toMatchObject({ status: { before: "unknown", after: "pending" }, confirmed_unknown: true, error_code: "smtp_maybe_sent" });
  });
});

describe("what the database refuses, whoever asks", () => {
  it("a delivery that is sent, pending or cancelled, one that does not exist, and one of an order that is not paid; nothing is audited", async () => {
    const sent = await delivery({ status: "sent" });
    const pending = await delivery({ status: "pending" });
    const unpaid = await delivery({ status: "failed", lastError: "smtp_rejected", orderStatus: "refunded" });
    for (const { id } of [sent, pending]) await expect(asAdmin(ownerId, () => resendDelivery(rt.sql, id, { confirmUnknown: true }))).rejects.toThrow(/Only a failed delivery/);
    await expect(asAdmin(ownerId, () => resendDelivery(rt.sql, unpaid.id))).rejects.toThrow(/not paid/);
    await expect(asAdmin(ownerId, () => resendDelivery(rt.sql, "00000000-0000-4000-8000-000000000000"))).rejects.toThrow(/no longer exists/);
    expect(await root`SELECT 1 FROM audit_log WHERE action = 'delivery.resend' AND entity_id = ANY (${[sent.id, pending.id, unpaid.id]})`).toEqual([]);
    expect([(await state(sent.id))?.status, (await state(pending.id))?.status, (await state(unpaid.id))?.status]).toEqual(["sent", "pending", "failed"]);
  });

  it("the console's login cannot move a delivery any other way (42501): it reads them and resends, nothing more", async () => {
    const { id } = await delivery({ status: "failed", lastError: "smtp_rejected" });
    for (const statement of [
      "UPDATE public.deliveries SET status = 'pending' WHERE id = $1",
      "DELETE FROM public.deliveries WHERE id = $1",
      "UPDATE public.delivery_openers SET status = 'pending' WHERE delivery_id = $1",
      "UPDATE public.waha_sends SET outcome = 'sent' WHERE delivery_id = $1",
    ]) await expect(rt.sql.unsafe(statement, [id]), statement).rejects.toMatchObject({ code: "42501" });
    expect((await state(id))?.status).toBe("failed");
  });
});
