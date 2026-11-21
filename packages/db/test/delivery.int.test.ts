// US-025: the DB side of delivery. A delivery that went out (or may have) never goes back on the send path (ET130, for
// every writer but the explicit resend), the ack function moves wa_ack forward only, the pool's send ledger and
// the session pacing columns are the worker's alone, and the WhatsApp delay is a bounded admin setting.
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, rolledBack, sql, sqlState } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

type Id = { id: string };

let base: { landingPageId: string; programId: string; productId: string };
beforeAll(async () => {
  const { productId, programId } = await createProgram();
  base = { landingPageId: await createLandingPage(programId), programId, productId };
});

/** A paid order with its email and WhatsApp deliveries, as the superuser. */
async function paidOrder(): Promise<{ orderId: string; email: string; whatsapp: string }> {
  const order = first(await sql<Id[]>`INSERT INTO orders ${sql({ ...orderRow(base), status: "pending" })} RETURNING id`);
  await sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
  const rows = await sql<{ id: string; channel: string }[]>`
    INSERT INTO deliveries (order_id, channel) VALUES (${order.id}, 'email'), (${order.id}, 'whatsapp') RETURNING id, channel`;
  const of = (channel: string): string => first(rows.filter((r) => r.channel === channel)).id;
  return { orderId: order.id, email: of("email"), whatsapp: of("whatsapp") };
}

const status = async (id: string): Promise<string> => first(await sql<{ status: string }[]>`SELECT status::text AS status FROM deliveries WHERE id = ${id}`).status;
const setStatus = (id: string, to: string) => sql`UPDATE deliveries SET status = ${to} WHERE id = ${id}`;

describe("a delivery that went out, or may have, is never put back on the send path (ET130)", () => {
  it("refuses sent -> anything else and unknown / failed -> anything but sent for worker_rw (no side door through cancelled)", async () => {
    const { email, whatsapp } = await paidOrder();
    await setStatus(email, "sent");
    for (const to of ["pending", "sending", "unknown", "failed", "cancelled"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = ${to} WHERE id = ${email}`)), `sent -> ${to}`).toBe("ET130");
    }
    for (const from of ["unknown", "failed"]) {
      await setStatus(whatsapp, from);
      for (const to of ["pending", "sending", "cancelled"]) {
        expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = ${to} WHERE id = ${whatsapp}`)), `${from} -> ${to}`).toBe("ET130");
      }
    }
    expect(await status(email)).toBe("sent");
    expect(await status(whatsapp)).toBe("failed");
  });

  it("closes the two-step detour: unknown / failed -> cancelled (payments' mark) -> pending is refused at the first step, so payments can never revive it", async () => {
    const { whatsapp } = await paidOrder();
    await setStatus(whatsapp, "unknown");
    // Step one is what a compromised or buggy path would try: take the row out as `cancelled`, with payments' own mark ...
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'cancelled', last_error = 'order_not_paid' WHERE id = ${whatsapp}`))).toBe("ET130");
    // ... and the revive of payments (cancelled -> pending) therefore never has a row to work on.
    const revived = await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'pending', last_error = NULL WHERE id = ${whatsapp} AND status = 'cancelled' AND last_error = 'order_not_paid' RETURNING id`);
    expect(revived).toEqual([]);
    expect(await status(whatsapp)).toBe("unknown");
  });

  it("gives the console no write on deliveries at all (SELECT only): the resend is public.resend_delivery", async () => {
    const { email } = await paidOrder();
    expect((await asRole("admin_rw", (tx) => tx`SELECT id FROM public.deliveries WHERE id = ${email}`)).length).toBe(1);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.deliveries SET status = 'cancelled' WHERE id = ${email}`))).toBe("42501");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.deliveries WHERE id = ${email}`))).toBe("42501");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.deliveries (order_id, channel) VALUES (${email}, 'email')`))).toBe("42501");
  });

  it("still lets the worker settle or park a row: unknown -> sent, retry sending -> pending, cancel and revive a pending row", async () => {
    const { whatsapp, email } = await paidOrder();
    await setStatus(whatsapp, "unknown");
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'sent', sent_at = now() WHERE id = ${whatsapp}`);
    expect(await status(whatsapp)).toBe("sent");
    // The ordinary life of a row: pending -> sending -> pending (a retry) -> sending -> failed.
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'sending' WHERE id = ${email}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'pending' WHERE id = ${email}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'sending' WHERE id = ${email}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'failed' WHERE id = ${email}`);
    // payments' cancel and revive of a pending row is untouched.
    const other = await paidOrder();
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'cancelled', last_error = 'order_not_paid' WHERE id = ${other.email}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'pending', last_error = NULL WHERE id = ${other.email}`);
    expect(await status(other.email)).toBe("pending");
  });

  it("lets the explicit resend through only as delivery_resend (the owner of public.resend_delivery), and operations as a superuser; migrator, which owns every other function, is refused", async () => {
    const { email, whatsapp } = await paidOrder();
    await setStatus(email, "sent");
    await setStatus(whatsapp, "unknown");
    // migrator owns the other DEFINER functions: it is no longer a way back (only the dedicated role is).
    expect(await sqlState(asRole("migrator", (tx) => tx`UPDATE public.deliveries SET status = 'pending' WHERE id = ${whatsapp}`))).toBe("ET130");
    await asRole("delivery_resend", (tx) => tx`UPDATE public.deliveries SET status = 'pending', lease_until = NULL, updated_at = now() WHERE id = ${whatsapp}`);
    expect(await status(whatsapp)).toBe("pending");
    await asRole("delivery_resend", (tx) => tx`UPDATE public.deliveries SET status = 'pending' WHERE id = ${email}`);
    expect(await status(email)).toBe("pending");
    // The resend role can change nothing but the machine's columns, and reads no personal data of the order.
    expect(await sqlState(asRole("delivery_resend", (tx) => tx`UPDATE public.deliveries SET channel = 'email' WHERE id = ${whatsapp}`))).toBe("42501");
    expect(await sqlState(asRole("delivery_resend", (tx) => tx`SELECT buyer_phone FROM public.orders`))).toBe("42501");
    // the superuser pool is `postgres`: operations may repair a row by hand
    await sql`UPDATE deliveries SET status = 'sent' WHERE id = ${email}`;
    await setStatus(email, "pending");
    expect(await status(email)).toBe("pending");
  });

  it("does not touch an update that leaves the status alone (the ack, the message id, the claim bookkeeping)", async () => {
    const { whatsapp } = await paidOrder();
    await setStatus(whatsapp, "sent");
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET wa_message_id = 'true_628123456789@c.us_ABC', last_error = NULL, updated_at = now() WHERE id = ${whatsapp}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'sent' WHERE id = ${whatsapp}`);
  });
});

describe("resend_delivery (the explicit Staff / Owner resend, owned by delivery_resend)", () => {
  const resend = (id: string, confirm?: boolean) =>
    asRole("admin_rw", (tx) => (confirm === undefined ? tx`SELECT public.resend_delivery(${id}::uuid) AS was` : tx`SELECT public.resend_delivery(${id}::uuid, ${confirm}::boolean) AS was`));

  it("puts a failed delivery back to pending, due now, with a fresh retry budget and no numbers tried, and says what it was (for the audit entry); `attempts` is never reset", async () => {
    const { email } = await paidOrder();
    await sql`UPDATE deliveries SET status = 'failed', attempts = 4, last_error = 'smtp_rejected', not_before = now() - interval '1 day' WHERE id = ${email}`;
    expect(first(await resend(email)).was).toBe("failed");
    const row = first(await sql<{ status: string; attempts: number; attempts_base: number; last_error: string | null; tried: number; due: boolean; lease_until: Date | null }[]>`
      SELECT status::text AS status, attempts, attempts_base, last_error, cardinality(tried_session_ids)::int AS tried, not_before <= now() AS due, lease_until FROM deliveries WHERE id = ${email}`);
    // The attempt number goes on from 4 (a stale finisher of an old claim holding attempt 4 can never record onto the next claim, which is attempt 5); the
    // budget (attempts - attempts_base) starts again from nothing.
    expect(row).toEqual({ status: "pending", attempts: 4, attempts_base: 4, last_error: null, tried: 0, due: true, lease_until: null });
    // A second resend after another failure keeps counting up.
    await sql`UPDATE deliveries SET status = 'failed', attempts = 6, last_error = 'smtp_rejected' WHERE id = ${email}`;
    await resend(email);
    expect(first(await sql<{ attempts: number; attempts_base: number }[]>`SELECT attempts, attempts_base FROM deliveries WHERE id = ${email}`)).toEqual({ attempts: 6, attempts_base: 6 });
  });

  it("is refused while the delivery's lease has not ended (a send may still be running), then goes through", async () => {
    const { whatsapp } = await paidOrder();
    await sql`UPDATE deliveries SET status = 'unknown', lease_until = now() + interval '2 minutes' WHERE id = ${whatsapp}`;
    expect(await sqlState(resend(whatsapp, true))).toBe("ET134");
    expect(await status(whatsapp)).toBe("unknown");
    await sql`UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = ${whatsapp}`;
    expect(first(await resend(whatsapp, true)).was).toBe("unknown");
    expect(await status(whatsapp)).toBe("pending");
  });

  it("keeps the retry budget consistent with the attempts: the base is never negative and never above them", async () => {
    const { email } = await paidOrder();
    for (const [attempts, base] of [[2, 3], [0, -1]] as const) {
      expect(await sqlState(sql`UPDATE deliveries SET attempts = ${attempts}, attempts_base = ${base} WHERE id = ${email}`), `${String(attempts)} ${String(base)}`).toBe("23514");
    }
    expect(await sqlState(sql`UPDATE deliveries SET reply_chat_id = 'not a chat' WHERE id = ${email}`)).toBe("23514");
    await sql`UPDATE deliveries SET attempts = 3, attempts_base = 2, reply_chat_id = '98765432101234@lid' WHERE id = ${email}`;
  });

  it("never resends an unknown delivery (a send that MAY have gone out) without the explicit confirmation, and refuses what is not failed or unknown", async () => {
    const { email, whatsapp } = await paidOrder();
    await setStatus(whatsapp, "unknown");
    expect(await sqlState(resend(whatsapp))).toBe("ET132");
    expect(await sqlState(resend(whatsapp, false))).toBe("ET132");
    expect(await status(whatsapp)).toBe("unknown");
    expect(first(await resend(whatsapp, true)).was).toBe("unknown");
    expect(await status(whatsapp)).toBe("pending");
    // A pending row is the worker's; a sent one the buyer's to ask for again; a cancelled one is payments'.
    for (const state of ["pending", "sent", "cancelled"]) {
      await sql`UPDATE deliveries SET status = ${state} WHERE id = ${email}`;
      expect(await sqlState(resend(email, true)), state).toBe("ET133");
      expect(await status(email), state).toBe(state);
    }
    expect(await sqlState(resend("00000000-0000-4000-8000-000000000000"))).toBe("ET010");
  });

  it("is refused for an order that is not paid (ET080), whoever asks", async () => {
    const { orderId, email } = await paidOrder();
    await setStatus(email, "failed");
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${orderId}`;
    expect(await sqlState(resend(email))).toBe("ET080");
    expect(await status(email)).toBe("failed");
  });

  it("is the console's only way back: admin_rw can run it, nobody else can, and the function runs as delivery_resend", async () => {
    const { email } = await paidOrder();
    await setStatus(email, "failed");
    for (const role of ["worker_rw", "public_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.resend_delivery(${email}::uuid)`)), role).toBe("42501");
    }
    expect(await status(email)).toBe("failed");
    expect(first(await sql<{ owner: string; definer: boolean }[]>`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS definer FROM pg_proc WHERE proname = 'resend_delivery'`)).toEqual({ owner: "delivery_resend", definer: true });
    await resend(email);
    expect(await status(email)).toBe("pending");
  });

  it("leaves the opener of a WhatsApp delivery alone (it is exactly-once on its own, ET131)", async () => {
    const { whatsapp } = await paidOrder();
    await sql`INSERT INTO delivery_openers (delivery_id, status, attempts) VALUES (${whatsapp}, 'sent', 1)`;
    await setStatus(whatsapp, "failed");
    await resend(whatsapp);
    expect(first(await sql<{ status: string }[]>`SELECT status FROM delivery_openers WHERE delivery_id = ${whatsapp}`).status).toBe("sent");
  });
});

describe("record_waha_ack (the verified ack webhook)", () => {
  const ack = (messageId: string, value: string) =>
    asRole("public_rw", async (tx) => first(await tx<{ changed: boolean }[]>`SELECT public.record_waha_ack(${messageId}, ${value}) AS changed`).changed);
  const stored = async (id: string): Promise<string | null> => first(await sql<{ wa_ack: string | null }[]>`SELECT wa_ack FROM deliveries WHERE id = ${id}`).wa_ack;

  async function sentMessage(): Promise<{ id: string; messageId: string }> {
    const { whatsapp } = await paidOrder();
    const messageId = `true_628123456789@c.us_${first(await sql<{ s: string }[]>`SELECT upper(substr(md5(random()::text), 1, 12)) AS s`).s}`;
    await sql`UPDATE deliveries SET status = 'sent', wa_message_id = ${messageId} WHERE id = ${whatsapp}`;
    return { id: whatsapp, messageId };
  }

  it("moves the ack forward only: queued, sent, delivered, read", async () => {
    const { id, messageId } = await sentMessage();
    expect(await stored(id)).toBeNull();
    expect(await ack(messageId, "sent")).toBe(true);
    expect(await ack(messageId, "sent")).toBe(false);
    expect(await ack(messageId, "queued")).toBe(false);
    expect(await stored(id)).toBe("sent");
    expect(await ack(messageId, "read")).toBe(true);
    expect(await ack(messageId, "delivered")).toBe(false);
    expect(await stored(id)).toBe("read");
  });

  it("counts failed only before the message was delivered, and lets a later ack follow a failed one", async () => {
    const early = await sentMessage();
    expect(await ack(early.messageId, "failed")).toBe(true);
    expect(await stored(early.id)).toBe("failed");
    expect(await ack(early.messageId, "delivered")).toBe(true);
    expect(await ack(early.messageId, "failed")).toBe(false);
    expect(await stored(early.id)).toBe("delivered");
  });

  it("changes nothing for an unknown message id, a bad ack or an e-mail row, and never raises", async () => {
    const { id, messageId } = await sentMessage();
    expect(await ack("true_628000000000@c.us_NOSUCH", "sent")).toBe(false);
    expect(await ack(messageId, "exploded")).toBe(false);
    expect(await ack("", "sent")).toBe(false);
    expect(await stored(id)).toBeNull();
    const { email } = await paidOrder();
    await sql`UPDATE deliveries SET wa_message_id = 'email-id' WHERE id = ${email}`;
    expect(await ack("email-id", "sent")).toBe(false);
  });

  it("is the only way public_rw touches a delivery", async () => {
    const { id } = await sentMessage();
    expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.deliveries SET wa_ack = 'read' WHERE id = ${id}`))).toBe("42501");
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT wa_ack FROM public.deliveries`))).toBe("42501");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`SELECT public.record_waha_ack('x', 'sent')`))).toBe("42501");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT public.record_waha_ack('x', 'sent')`))).toBe("42501");
  });
});

describe("the pool's ledger, pacing and inbound outcome belong to the worker", () => {
  async function session(): Promise<string> {
    const server = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W', 'https://waha.invalid/', 'waha.invalid') RETURNING id`);
    return first(await sql<Id[]>`INSERT INTO waha_sessions (server_id, session_name) VALUES (${server.id}, 'default') RETURNING id`).id;
  }

  it("lets the worker append, read and prune sends, and the console only read them", async () => {
    const sessionId = await session();
    const { whatsapp } = await paidOrder();
    const sendId = await asRole("worker_rw", async (tx) => first(await tx<Id[]>`INSERT INTO public.waha_sends (session_id, delivery_id, kind) VALUES (${sessionId}, ${whatsapp}, 'opener') RETURNING id`).id);
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.waha_sends (session_id, kind) VALUES (${sessionId}, 'otp')`);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`INSERT INTO public.waha_sends (session_id, kind) VALUES (${sessionId}, 'blast')`))).toBe("23514");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sends SET kind = 'text' WHERE id = ${sendId}`))).toBe("42501");
    // How the send ended is the one column the worker writes (the delivery report counts it per number): reserved at the claim, then sent / unknown / failed.
    expect(first(await sql<{ outcome: string }[]>`SELECT outcome FROM waha_sends WHERE id = ${sendId}`).outcome).toBe("reserved");
    for (const outcome of ["sent", "unknown", "failed", "reserved"]) {
      await asRole("worker_rw", (tx) => tx`UPDATE public.waha_sends SET outcome = ${outcome} WHERE id = ${sendId}`);
    }
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sends SET outcome = 'maybe' WHERE id = ${sendId}`))).toBe("23514");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.waha_sends SET outcome = 'sent' WHERE id = ${sendId}`))).toBe("42501");
    expect((await asRole("admin_rw", (tx) => tx`SELECT id FROM public.waha_sends WHERE id = ${sendId}`)).length).toBe(1);
    for (const statement of [
      (tx: Parameters<Parameters<typeof asRole>[1]>[0]) => tx`INSERT INTO public.waha_sends (session_id, kind) VALUES (${sessionId}, 'otp')`,
      (tx: Parameters<Parameters<typeof asRole>[1]>[0]) => tx`DELETE FROM public.waha_sends WHERE id = ${sendId}`,
      (tx: Parameters<Parameters<typeof asRole>[1]>[0]) => tx`UPDATE public.waha_sends SET kind = 'text' WHERE id = ${sendId}`,
    ]) {
      expect(await sqlState(asRole("admin_rw", statement))).toBe("42501");
    }
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT id FROM public.waha_sends`))).toBe("42501");
    await asRole("worker_rw", (tx) => tx`DELETE FROM public.waha_sends WHERE id = ${sendId}`);
    // a session that has sends cannot be deleted (ON DELETE RESTRICT)
    expect(await sqlState(sql`DELETE FROM waha_sessions WHERE id = ${sessionId}`)).toBe("23001");
  });

  it("lets the worker pace and rest a number, but nothing else about it", async () => {
    const sessionId = await session();
    await asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET next_send_at = now(), fail_streak = 2, cooldown_until = now(), status = 'WORKING', status_at = now() WHERE id = ${sessionId}`);
    for (const column of ["weight", "daily_cap", "active", "phone"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET ${tx(column)} = ${tx(column)} WHERE id = ${sessionId}`))).toBe("42501");
    }
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET fail_streak = -1 WHERE id = ${sessionId}`))).toBe("23514");
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT next_send_at FROM public.waha_sessions`))).toBe("42501");
  });

  it("lets the worker record what it did with an inbound message, and no more", async () => {
    const row = first(
      await sql<Id[]>`INSERT INTO waha_inbound (message_id, session_name, from_jid, raw) VALUES (${`false_628123456789@c.us_${suffixOf()}`}, 'default', '628123456789@c.us', '{}') RETURNING id`,
    );
    await asRole("worker_rw", (tx) => tx`UPDATE public.waha_inbound SET outcome = 'text_only', replied_at = now(), processed_at = now() WHERE id = ${row.id}`);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_inbound SET outcome = 'Not A Code' WHERE id = ${row.id}`))).toBe("23514");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_inbound SET message_id = 'other' WHERE id = ${row.id}`))).toBe("42501");
    expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.waha_inbound SET outcome = 'delivered' WHERE id = ${row.id}`))).toBe("42501");
    // The webhook route stores no message text: public_rw may write the row's identity and the raw event, never `body`.
    expect(await sqlState(asRole("public_rw", (tx) => tx`INSERT INTO public.waha_inbound (message_id, session_name, from_jid, body, raw) VALUES (${`false_628123456789@c.us_${suffixOf()}`}, 'default', '628123456789@c.us', 'KODE X', '{}')`))).toBe("42501");
  });
});

describe("the opener of a WhatsApp delivery is exactly-once on its own (ET131, Owner decision D7)", () => {
  type Tx = Parameters<Parameters<typeof asRole>[1]>[0];
  const openerStatus = async (id: string): Promise<string> => first(await sql<{ status: string }[]>`SELECT status FROM delivery_openers WHERE delivery_id = ${id}`).status;
  const setOpener = (id: string, to: string) => sql`UPDATE delivery_openers SET status = ${to} WHERE delivery_id = ${id}`;
  async function opener(): Promise<string> {
    const { whatsapp } = await paidOrder();
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.delivery_openers (delivery_id) VALUES (${whatsapp})`);
    return whatsapp;
  }

  it("is created by the worker as pending; the console reads it and never writes it; the webhook route cannot see it", async () => {
    const id = await opener();
    expect(await openerStatus(id)).toBe("pending");
    expect((await asRole("admin_rw", (tx) => tx`SELECT delivery_id FROM public.delivery_openers WHERE delivery_id = ${id}`)).length).toBe(1);
    for (const statement of [
      (tx: Tx) => tx`INSERT INTO public.delivery_openers (delivery_id) VALUES (${id})`,
      (tx: Tx) => tx`UPDATE public.delivery_openers SET status = 'sent' WHERE delivery_id = ${id}`,
      (tx: Tx) => tx`DELETE FROM public.delivery_openers WHERE delivery_id = ${id}`,
    ]) {
      expect(await sqlState(asRole("admin_rw", statement))).toBe("42501");
    }
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT * FROM public.delivery_openers`))).toBe("42501");
    // one opener per delivery
    expect(await sqlState(asRole("worker_rw", (tx) => tx`INSERT INTO public.delivery_openers (delivery_id) VALUES (${id})`))).toBe("23505");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = 'resent' WHERE delivery_id = ${id}`))).toBe("23514");
    // the worker moves the opener's own columns and nothing else
    await asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = 'sending', attempts = 1, lease_until = now(), last_error = NULL, updated_at = now() WHERE delivery_id = ${id}`);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET delivery_id = gen_random_uuid() WHERE delivery_id = ${id}`))).toBe("42501");
  });

  it("never goes back on the send path: sent, failed and expired are final, unknown can only become sent", async () => {
    for (const from of ["sent", "failed", "expired"]) {
      const id = await opener();
      await setOpener(id, from);
      for (const to of ["pending", "sending", "unknown", "sent", "failed", "expired"].filter((s) => s !== from)) {
        expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = ${to} WHERE delivery_id = ${id}`)), `${from} -> ${to}`).toBe("ET131");
      }
      expect(await openerStatus(id)).toBe(from);
    }
    const unknown = await opener();
    await setOpener(unknown, "unknown");
    for (const to of ["pending", "sending", "failed", "expired"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = ${to} WHERE delivery_id = ${unknown}`)), `unknown -> ${to}`).toBe("ET131");
    }
    // the late outcome of the send itself settles it
    await asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = 'sent', sent_at = now() WHERE delivery_id = ${unknown}`);
    expect(await openerStatus(unknown)).toBe("sent");
  });

  it("lets the worker run the ordinary life: pending -> sending -> pending (a retry) -> sending -> sent, and pending -> expired (the buyer wrote first)", async () => {
    const id = await opener();
    for (const to of ["sending", "pending", "sending", "sent"]) await asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = ${to} WHERE delivery_id = ${id}`);
    const moot = await opener();
    await asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = 'expired', last_error = 'buyer_wrote' WHERE delivery_id = ${moot}`);
    // an update that leaves the status alone is not guarded (the message id, the bookkeeping)
    await asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET wa_message_id = 'true_x', last_error = NULL, updated_at = now() WHERE delivery_id = ${id}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.delivery_openers SET status = 'sent' WHERE delivery_id = ${id}`);
  });

  it("only a superuser (operations, repairs by hand) passes the guard: there is no resend of an opener", async () => {
    const id = await opener();
    await setOpener(id, "sent");
    await setOpener(id, "pending");
    expect(await openerStatus(id)).toBe("pending");
    expect(await sqlState(asRole("delivery_resend", (tx) => tx`UPDATE public.delivery_openers SET status = 'pending' WHERE delivery_id = ${id}`))).toBe("42501");
  });

  it("is deleted with its delivery (a delivery is never deleted in practice; the cascade keeps the table honest)", async () => {
    const id = await opener();
    await sql`DELETE FROM deliveries WHERE id = ${id}`;
    expect(await sql`SELECT 1 FROM delivery_openers WHERE delivery_id = ${id}`).toHaveLength(0);
  });
});

describe("what WAHA said about a phone (wa_contacts) and the new-contact columns of the ledger", () => {
  async function session(): Promise<string> {
    const server = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W', 'https://waha.invalid/', 'waha.invalid') RETURNING id`);
    return first(await sql<Id[]>`INSERT INTO waha_sessions (server_id, session_name) VALUES (${server.id}, 'default') RETURNING id`).id;
  }
  const phone = () => `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;

  it("a lid belongs to ONE phone: a second row cannot take it (23505) until the first lets it go, and a phone can hold none", async () => {
    const a = phone();
    const b = phone();
    const lid = `${String(10_000_000_000 + Math.floor(Math.random() * 80_000_000_000))}@lid`;
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid) VALUES (${a}, true, ${lid}, ${lid})`);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid) VALUES (${b}, true, ${lid}, ${lid})`))).toBe("23505");
    await asRole("worker_rw", (tx) => tx`UPDATE public.wa_contacts SET lid = NULL WHERE phone = ${a}`);
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid) VALUES (${b}, true, ${lid}, ${lid})`);
    // Phones with no lid are many.
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id) VALUES (${phone()}, true, '628111111111@c.us')`);
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id) VALUES (${phone()}, true, '628111111112@c.us')`);
  });

  it("is the worker's alone: it reads, inserts and updates what check-exists said; the console reads, nobody else sees it, and it holds only well-formed ids", async () => {
    const p = phone();
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid) VALUES (${p}, true, '98765432101234@lid', '98765432101234@lid')`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.wa_contacts SET number_exists = false, chat_id = NULL, checked_at = now(), lid_checked_at = now() WHERE phone = ${p}`);
    expect((await asRole("admin_rw", (tx) => tx`SELECT phone FROM public.wa_contacts WHERE phone = ${p}`)).length).toBe(1);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.wa_contacts WHERE phone = ${p}`))).toBe("42501");
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT phone FROM public.wa_contacts`))).toBe("42501");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`DELETE FROM public.wa_contacts WHERE phone = ${p}`))).toBe("42501");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.wa_contacts SET phone = '+6281200000000' WHERE phone = ${p}`))).toBe("42501");
    // the constraints: an E.164 phone, a chat id of the two shapes, a lid that is a lid, a number that exists has a chat to send to
    for (const [number, exists, chat, lid] of [
      ["0812345", true, "628123456789@c.us", null],
      [phone(), true, "628123456789@g.us", null],
      [phone(), true, "../x@c.us", null],
      [phone(), true, "628123456789@c.us", "628123456789@c.us"],
      [phone(), true, null, null],
    ] as const) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid) VALUES (${number}, ${exists}, ${chat}, ${lid})`)), `${number} ${String(chat)} ${String(lid)}`).toBe("23514");
    }
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.wa_contacts (phone, number_exists) VALUES (${phone()}, false)`);
  });

  it("marks the sends that spend the new-contact budget, and keeps the per-contact digest well-formed", async () => {
    const sessionId = await session();
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.waha_sends (session_id, kind, contact_key, send_at, new_contact) VALUES (${sessionId}, 'opener', ${"a".repeat(64)}, now(), true)`);
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.waha_sends (session_id, kind) VALUES (${sessionId}, 'reply')`);
    expect(await sql`SELECT new_contact FROM waha_sends WHERE session_id = ${sessionId} ORDER BY kind`).toEqual([{ new_contact: true }, { new_contact: false }]);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`INSERT INTO public.waha_sends (session_id, kind, contact_key) VALUES (${sessionId}, 'opener', '628123456789')`))).toBe("23514");
  });

  it("lets the worker persist WhatsApp's limits on a number (timelock, capping, the 463 / 475 counts, its new-contact budget is the Owner's), and nothing else", async () => {
    const sessionId = await session();
    await asRole("worker_rw", (tx) => tx`
      UPDATE public.waha_sessions SET reachout_until = now() + interval '1 hour', warning_level = 'first', timelock_active = true, timelock_ends_at = now(), capping_status = 'FIRST_WARNING',
             capping_total_quota = 100, capping_used_quota = 80, capping_cycle_end = now(), limits_checked_at = now(), ban_463_count = 1, ban_475_count = 2 WHERE id = ${sessionId}`);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET warning_level = 'third' WHERE id = ${sessionId}`))).toBe("23514");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET capping_status = 'first warning' WHERE id = ${sessionId}`))).toBe("23514");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET ban_463_count = -1 WHERE id = ${sessionId}`))).toBe("23514");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.waha_sessions SET new_contact_cap = 999 WHERE id = ${sessionId}`))).toBe("42501");
    expect(await sqlState(sql`UPDATE waha_sessions SET new_contact_cap = -1 WHERE id = ${sessionId}`)).toBe("23514");
    expect(first(await sql<{ new_contact_cap: number }[]>`SELECT new_contact_cap FROM waha_sessions WHERE id = ${sessionId}`).new_contact_cap).toBe(30);
  });
});

describe("record_waha_session_state (the verified session.status webhook) and waha_reply_expected", () => {
  async function session(name: string, active = true): Promise<string> {
    const server = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`W${suffixOf()}`}, 'https://waha.invalid/', 'waha.invalid') RETURNING id`);
    return first(await sql<Id[]>`INSERT INTO waha_sessions (server_id, session_name, active) VALUES (${server.id}, ${name}, ${active}) RETURNING id`).id;
  }
  const record = (name: string, timelock: unknown, capping: unknown) =>
    asRole("public_rw", async (tx) => first(await tx<{ recorded: boolean }[]>`SELECT public.record_waha_session_state(${name}, ${timelock === null ? null : JSON.stringify(timelock)}::text::jsonb, ${capping === null ? null : JSON.stringify(capping)}::text::jsonb) AS recorded`).recorded);
  const stateOf = async (id: string) =>
    first(await sql<{ timelock_active: boolean; capping_status: string | null; warning_level: string; reachout_until: Date | null; capping_total_quota: number | null; capping_used_quota: number | null }[]>`
      SELECT timelock_active, capping_status, warning_level, reachout_until, capping_total_quota, capping_used_quota FROM waha_sessions WHERE id = ${id}`);
  const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;

  it("records an active timelock (blocked until its end) and a capping state, from a session name that belongs to one active session", async () => {
    const name = `lim${suffixOf()}`.slice(0, 20);
    const id = await session(name);
    expect(await record(name, { isActive: true, timeEnforcementEnds: inSeconds(7200) }, { cappingStatus: "SECOND_WARNING", totalQuota: 100, usedQuota: 90, cycleEnd: inSeconds(86_400) })).toBe(true);
    const state = await stateOf(id);
    expect(state).toMatchObject({ timelock_active: true, capping_status: "SECOND_WARNING", warning_level: "second", capping_total_quota: 100, capping_used_quota: 90 });
    expect(Math.abs((state.reachout_until?.getTime() ?? 0) - (Date.now() + 7_200_000))).toBeLessThan(30_000);
    // CAPPED blocks until the cycle's end, but one event extends a block by 24 hours at most (the worker's poll is the authority for longer); a block is only ever
    // extended by an event, never shortened
    expect(await record(name, null, { cappingStatus: "CAPPED", cycleEnd: inSeconds(3 * 86_400) })).toBe(true);
    expect(Math.abs(((await stateOf(id)).reachout_until?.getTime() ?? 0) - (Date.now() + 24 * 3_600_000))).toBeLessThan(30_000);
    expect(await record(name, { isActive: false }, { cappingStatus: "NONE" })).toBe(true);
    const clear = await stateOf(id);
    expect(clear).toMatchObject({ timelock_active: false, capping_status: "NONE", warning_level: "none" });
    expect(Math.abs((clear.reachout_until?.getTime() ?? 0) - (Date.now() + 24 * 3_600_000))).toBeLessThan(30_000);
  });

  it("blocks for an hour when WAHA names no end, extends by at most 24 hours per event (the worker's poll is the authority for longer), and ignores what is not a limit", async () => {
    const name = `lim${suffixOf()}`.slice(0, 20);
    const id = await session(name);
    await record(name, { isActive: true }, null);
    expect(Math.abs(((await stateOf(id)).reachout_until?.getTime() ?? 0) - (Date.now() + 3_600_000))).toBeLessThan(30_000);
    await record(name, { isActive: true, timeEnforcementEnds: inSeconds(400 * 86_400) }, null);
    expect(((await stateOf(id)).reachout_until?.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(24 * 3_600_000 + 30_000);
    expect(((await stateOf(id)).reachout_until?.getTime() ?? 0) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    for (const [timelock, capping] of [[null, null], [{}, {}], [{ isActive: "yes" }, { cappingStatus: "capped" }], ["x", [1]], [null, { cappingStatus: 5 }]] as const) {
      expect(await record(name, timelock, capping), JSON.stringify([timelock, capping])).toBe(false);
    }
    // out-of-range numbers are dropped, the state they sit in is still recorded
    expect(await record(name, null, { cappingStatus: "NONE", totalQuota: 99_999_999, usedQuota: -5, cycleEnd: -1 })).toBe(true);
    expect(await stateOf(id)).toMatchObject({ capping_total_quota: null, capping_used_quota: null });
  });

  it("updates nothing when the session name is unknown, inactive or ambiguous (the same name on two servers), or malformed", async () => {
    const twin = `twin${suffixOf()}`.slice(0, 20);
    const a = await session(twin);
    const b = await session(twin);
    expect(await record(twin, { isActive: true }, null)).toBe(false);
    expect((await stateOf(a)).timelock_active).toBe(false);
    expect((await stateOf(b)).timelock_active).toBe(false);
    const off = `off${suffixOf()}`.slice(0, 20);
    await session(off, false);
    expect(await record(off, { isActive: true }, null)).toBe(false);
    expect(await record("nobody", { isActive: true }, null)).toBe(false);
    for (const bad of ["", "has space", "../x", "x".repeat(65)]) expect(await record(bad, { isActive: true }, null), bad).toBe(false);
    expect(await asRole("public_rw", async (tx) => first(await tx<{ recorded: boolean }[]>`SELECT public.record_waha_session_state(NULL, '{"isActive":true}'::jsonb, NULL) AS recorded`).recorded)).toBe(false);
  });

  it("is executable by the webhook route only: it can change a session through nobody else", async () => {
    const name = `lim${suffixOf()}`.slice(0, 20);
    await session(name);
    for (const role of ["admin_rw", "worker_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.record_waha_session_state(${name}, '{"isActive":true}'::jsonb, NULL)`)), role).toBe("42501");
    }
  });

  it("waha_reply_expected: a chat that owes us a reply (a code-less answer to our opener) is kept, any other chatter is not", async () => {
    const name = `rep${suffixOf()}`.slice(0, 20);
    const sessionId = await session(name);
    const phone = `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
    const order = first(await sql<Id[]>`INSERT INTO orders ${sql({ ...orderRow(base), status: "pending", buyer_phone: phone })} RETURNING id`);
    await sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
    const delivery = first(await sql<Id[]>`INSERT INTO deliveries (order_id, channel) VALUES (${order.id}, 'whatsapp') RETURNING id`).id;
    const expected = (jid: string, sessionName = name) => asRole("public_rw", async (tx) => first(await tx<{ expected: boolean }[]>`SELECT public.waha_reply_expected(${sessionName}, ${jid}) AS expected`).expected);
    const chat = `${phone.slice(1)}@c.us`;
    // no opener yet: nothing is expected
    expect(await expected(chat)).toBe(false);
    await sql`INSERT INTO delivery_openers (delivery_id, status, session_id) VALUES (${delivery}, 'pending', ${sessionId})`;
    expect(await expected(chat)).toBe(false);
    await sql`UPDATE delivery_openers SET status = 'sent', sent_at = now() WHERE delivery_id = ${delivery}`;
    expect(await expected(chat)).toBe(true);
    // only that chat, and only on the number that wrote the opener
    expect(await expected("6281999999999@c.us")).toBe(false);
    expect(await expected(chat, "othername")).toBe(false);
    expect(await expected("628123@g.us")).toBe(false);
    // a lid: the phone's own (taught by check-exists) is expected, another phone's is not, an unknown one is (the worker asks WAHA who it is)
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid) VALUES (${phone}, true, '55555555555555@lid', '55555555555555@lid')`;
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid) VALUES ('+6281000000001', true, '66666666666666@lid', '66666666666666@lid')`;
    expect(await expected("55555555555555@lid")).toBe(true);
    expect(await expected("66666666666666@lid")).toBe(false);
    expect(await expected("77777777777777@lid")).toBe(true);
    // it may have been sent (unknown) and still expects the reply; once the buyer has been served (the delivery is no longer pending) nothing is expected
    await sql`UPDATE delivery_openers SET status = 'unknown' WHERE delivery_id = ${delivery}`;
    expect(await expected(chat)).toBe(true);
    await sql`UPDATE deliveries SET status = 'sending' WHERE id = ${delivery}`;
    expect(await expected(chat)).toBe(false);
    expect(await expected(null as unknown as string)).toBe(false);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT public.waha_reply_expected(${name}, ${chat})`))).toBe("42501");
  });
});

function suffixOf(): string {
  return Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(10, "0");
}

describe("delivery.wa_delay_seconds (AC-D8: the proactive WhatsApp delay, default 3 minutes, 0 sends at once)", () => {
  const set = (value: string) => sql`UPDATE app_settings SET value = ${value}::jsonb WHERE key = 'delivery.wa_delay_seconds'`;

  it("is seeded at 180 and bounded 0..86400", async () => {
    expect(first(await sql<{ value: number }[]>`SELECT value FROM app_settings WHERE key = 'delivery.wa_delay_seconds'`).value).toBe(180);
    await rolledBack(null, async (tx) => {
      await tx`UPDATE app_settings SET value = '0'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
      await tx`UPDATE app_settings SET value = '86400'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
    });
    for (const bad of ["-1", "86401", '"180"', "null"]) expect(await sqlState(set(bad))).toBe("23514");
  });
});
