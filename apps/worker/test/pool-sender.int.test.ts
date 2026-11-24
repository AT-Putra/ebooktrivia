// US-025: a text message out of the pool (src/delivery/pool-sender.ts), the port the player's OTP sender sits behind. It uses the same numbers, caps,
// pacing, failover and health as a delivery, and never tries a second number after a send that may have gone out.
import { NotSentError } from "@ebooktrivia/adapters";
import { toWaChatId, type IdMobileE164, OTP_GAP_MS } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPoolSender, PoolSendError } from "../src/delivery/pool-sender.ts";
import type { WahaAccess } from "../src/delivery/ports.ts";
import { createSession, createWahaFake, retireSessions } from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(4);
beforeEach(retireSessions);
afterAll(retireSessions);

const TO = (): IdMobileE164 => uniquePhone() as IdMobileE164;

function rig() {
  const waha = createWahaFake();
  const slept: number[] = [];
  const sender = createPoolSender({
    sql: workerSql,
    log: silentLog,
    waha: waha.access,
    random: () => 0,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  return { waha, sender, slept };
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof PoolSendError) return error.code;
    throw error;
  }
  return "sent";
};
const health = async (id: string) => first(await sql<{ fail_streak: number }[]>`SELECT fail_streak FROM waha_sessions WHERE id = ${id}`).fail_streak;

describe("a text out of the pool", () => {
  it("goes from a WORKING number, is recorded as an OTP send with the short gap, and counts against the cap", async () => {
    const r = rig();
    const session = await createSession({ dailyCap: 2 });
    const to = TO();
    expect(await r.sender.sendText({ to, text: "Kode masuk 123456" })).toEqual({ sessionId: session.id });
    expect(r.waha.sent).toEqual([expect.objectContaining({ kind: "text", session: session.name, chatId: toWaChatId(to), text: "Kode masuk 123456" })]);
    expect(await sql`SELECT kind, delivery_id FROM waha_sends WHERE session_id = ${session.id}`).toEqual([{ kind: "otp", delivery_id: null }]);
    const slot = first(await sql<{ next_send_at: Date }[]>`SELECT next_send_at FROM waha_sessions WHERE id = ${session.id}`).next_send_at;
    expect(slot.getTime() - Date.now()).toBeLessThanOrEqual(OTP_GAP_MS[0] + 100);
    // The second one (to another player) waits for the number's slot (the short gap): the first send slept its slot, the typing and the short pause.
    await r.sender.sendText({ to: TO(), text: "x" });
    expect(r.slept).toHaveLength(6);
    expect(r.slept[3]).toBeGreaterThan(OTP_GAP_MS[0] - 700);
    // The third finds the number at its cap.
    expect(await code(r.sender.sendText({ to: TO(), text: "y" }))).toBe("no_number");
    expect(r.waha.sent).toHaveLength(2);
  });

  it("refuses an empty or whitespace-only text BEFORE a number is claimed (WEBJS would send an empty message): a NotSentError, no WAHA call (no typing), no ledger row, no health change", async () => {
    const r = rig();
    const session = await createSession({ dailyCap: 5 });
    for (const text of ["", " ", "\n\t  "]) await expect(r.sender.sendText({ to: TO(), text }), JSON.stringify(text)).rejects.toThrow(NotSentError);
    expect(r.waha.calls).toEqual([]);
    expect(r.waha.sent).toHaveLength(0);
    expect(r.slept).toEqual([]);
    expect(await sql`SELECT id FROM waha_sends WHERE session_id = ${session.id}`).toEqual([]);
    expect(await health(session.id)).toBe(0);
    // A real one still goes.
    expect(await r.sender.sendText({ to: TO(), text: "Kode 123456" })).toEqual({ sessionId: session.id });
  });

  it("an argument the adapter refuses before it makes any request (a NotSentError after the claim) is NOT an uncertain send: the claim is given back, the failure is definite, nothing is `unknown`", async () => {
    const waha = createWahaFake();
    const session = await createSession();
    const refusing: WahaAccess = {
      withSession: (sessionId, use, options) =>
        waha.access.withSession(sessionId, (access) => use({ ...access, client: { ...access.client, sendText: () => Promise.reject(new NotSentError("invalid WhatsApp chat id")) } }), options),
    };
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: refusing, random: () => 0, sleep: () => Promise.resolve() });
    expect(await code(sender.sendText({ to: TO(), text: "Kode 123456" }))).toBe("failed");
    expect(await sql`SELECT outcome FROM waha_sends WHERE session_id = ${session.id}`).toEqual([]);
    expect(await health(session.id)).toBe(0);
  });

  it("any OTHER error, even a plain RangeError thrown after the request has left, is an uncertain send: the ledger row is `unknown`, the error is maybe_sent, and no second number is tried (never resent)", async () => {
    const waha = createWahaFake();
    const first = await createSession({ weight: 5 });
    const second = await createSession({ weight: 1 });
    const afterTheRequest: WahaAccess = {
      withSession: (sessionId, use, options) =>
        waha.access.withSession(
          sessionId,
          (access) =>
            use({
              ...access,
              // The send DID go out; then something of ours raised a RangeError (not the adapter's NotSentError).
              client: {
                ...access.client,
                sendText: async (...args) => {
                  await access.client.sendText(...args);
                  throw new RangeError("raised after the request left");
                },
              },
            }),
          options,
        ),
    };
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: afterTheRequest, random: () => 0, sleep: () => Promise.resolve() });
    expect(await code(sender.sendText({ to: TO(), text: "Kode 123456" }))).toBe("maybe_sent");
    expect(waha.sent).toHaveLength(1);
    expect(await sql`SELECT outcome FROM waha_sends WHERE session_id = ${first.id}`).toEqual([{ outcome: "unknown" }]);
    expect(await sql`SELECT outcome FROM waha_sends WHERE session_id = ${second.id}`).toEqual([]);
  });

  it("fails over to another number on a definite failure, and records the failure on the first", async () => {
    const r = rig();
    const dead = await createSession({ weight: 5 });
    const alive = await createSession({ weight: 1 });
    await r.waha.status(dead.name, "STOPPED");
    expect(await r.sender.sendText({ to: TO(), text: "Kode" })).toEqual({ sessionId: alive.id });
    expect(r.waha.sent).toHaveLength(1);
    expect(r.waha.sent[0]?.session).toBe(alive.name);
    expect(await health(dead.id)).toBe(1);
    expect(await health(alive.id)).toBe(0);
  });

  it("never tries a second number after a send that may have gone out", async () => {
    const r = rig();
    const flaky = await createSession({ weight: 5 });
    const other = await createSession({ weight: 1 });
    r.waha.fault(flaky.name, "timeout_after_send");
    expect(await code(r.sender.sendText({ to: TO(), text: "Kode" }))).toBe("maybe_sent");
    // The number DID send it; no other number was asked.
    expect(r.waha.sent).toHaveLength(1);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${other.id}`).toEqual([]);
    expect(await health(flaky.id)).toBe(1);
  });

  it("gives up after three numbers refused it, and says there is no number when none can take it (with the persisted pool alert)", async () => {
    const r = rig();
    const sessions = await Promise.all([4, 3, 2, 1].map((weight) => createSession({ weight })));
    for (const s of sessions) await r.waha.status(s.name, "FAILED");
    expect(await code(r.sender.sendText({ to: TO(), text: "Kode" }))).toBe("failed");
    expect(r.waha.sent).toHaveLength(0);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${sessions[3]?.id ?? ""}`).toEqual([]);

    await retireSessions();
    await sql`UPDATE alerts SET resolved_at = now() WHERE kind = 'wa_pool_empty'`;
    expect(await code(r.sender.sendText({ to: TO(), text: "Kode" }))).toBe("no_number");
    expect(await sql`SELECT severity FROM alerts WHERE kind = 'wa_pool_empty' AND resolved_at IS NULL`).toEqual([{ severity: "critical" }]);
  });
});

describe("a text out of the pool: human-like, first contact, and WhatsApp's limits", () => {
  it("asks WAHA where the phone lives, marks the whole chat as read, then types, pauses, sends and goes offline: a short, human sequence with no reading pause, and the chat id WAHA returned (a @lid) is where it goes", async () => {
    const r = rig();
    const session = await createSession();
    const to = TO();
    const lid = "98765432109876@lid";
    await r.waha.contact(to, { chatId: lid, pn: toWaChatId(to) });
    await r.waha.clearCallLog();
    await r.sender.sendText({ to, text: "Kode masuk 123456" });
    expect(r.waha.sent).toEqual([expect.objectContaining({ session: session.name, chatId: lid })]);
    const calls = await r.waha.callLog();
    expect(calls.map((c) => `${c.path.replace(/^\/api\/[^/]+\/presence$/, "/presence")}${typeof c.body["presence"] === "string" ? `:${c.body["presence"]}` : ""}`)).toEqual([
      "/api/contacts/check-exists",
      "/api/sendSeen",
      "/presence:typing",
      "/presence:paused",
      "/api/sendText",
      "/presence:offline",
    ]);
    // The seen mark is of the WHOLE chat (the chat WAHA returned, no message ids).
    expect(calls[1]?.body).toEqual({ session: session.name, chatId: lid });
    // Whatever it waits for stays short for a player who is waiting: the slot, then at most ~4 s of typing and pausing (no reading pause after the seen mark).
    expect(r.slept).toHaveLength(3);
    expect((r.slept[1] ?? 0) + (r.slept[2] ?? 0)).toBeLessThanOrEqual(4000);
    // A new contact: counted against the number's budget of them, and the answer of WAHA is cached for the next message.
    expect(await sql`SELECT new_contact, contact_key IS NOT NULL AS keyed FROM waha_sends WHERE session_id = ${session.id}`).toEqual([{ new_contact: true, keyed: true }]);
    expect(await sql`SELECT chat_id FROM wa_contacts WHERE phone = ${to}`).toEqual([{ chat_id: lid }]);
  });

  it("a phone that is not on WhatsApp is no_whatsapp: nothing is sent, no number is penalised, no ledger row remains", async () => {
    const r = rig();
    const a = await createSession({ weight: 5 });
    const b = await createSession();
    const to = TO();
    await r.waha.contact(to, { numberExists: false });
    expect(await code(r.sender.sendText({ to, text: "Kode" }))).toBe("no_whatsapp");
    expect(r.waha.sent).toEqual([]);
    expect(await health(a.id)).toBe(0);
    expect(await health(b.id)).toBe(0);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ANY(${[a.id, b.id]}::uuid[])`).toEqual([]);
  });

  it("a check-exists that fails sends nothing, is no penalty, and the next number is asked (three numbers at most)", async () => {
    const r = rig();
    const a = await createSession({ weight: 5 });
    await createSession();
    await r.waha.presenceFault("http500");
    expect(await code(r.sender.sendText({ to: TO(), text: "Kode" }))).toBe("failed");
    expect(r.waha.sent).toEqual([]);
    expect(await health(a.id)).toBe(0);
    await r.waha.presenceFault("ok");
    expect(await code(r.sender.sendText({ to: TO(), text: "Kode" }))).toBe("sent");
  });

  it("a second code to the same contact is not held longer than the lease allows: contact_limit, nothing sent, retried later by the outbox", async () => {
    const r = rig();
    await createSession({ dailyCap: 100 });
    const to = TO();
    await r.sender.sendText({ to, text: "Kode 1" });
    expect(await code(r.sender.sendText({ to, text: "Kode 2" }))).toBe("contact_limit");
    expect(r.waha.sent).toHaveLength(1);
    // The refused one left no ledger row; after the gap it goes.
    await sql`UPDATE waha_sends SET send_at = now() - interval '2 minutes'`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await code(r.sender.sendText({ to, text: "Kode 2" }))).toBe("sent");
    expect(r.waha.sent).toHaveLength(2);
  });

  it("at most 4 messages an hour to one contact", async () => {
    const r = rig();
    const s = await createSession({ dailyCap: 100 });
    const to = TO();
    const key = first(await sql<{ k: string }[]>`SELECT encode(sha256(convert_to('ebooktrivia/contact/v1|' || ${to}, 'UTF8')), 'hex') AS k`).k;
    await sql`INSERT INTO waha_sends (session_id, kind, contact_key, send_at) SELECT ${s.id}, 'otp', ${key}, now() - (g * interval '10 minutes') FROM generate_series(1, 4) g`;
    expect(await code(r.sender.sendText({ to, text: "Kode" }))).toBe("contact_limit");
    expect(r.waha.sent).toEqual([]);
  });

  it("a 463 holds the number back from new contacts (not a failure of its health) and the next number sends it", async () => {
    const r = rig();
    const limited = await createSession({ weight: 5 });
    const free = await createSession();
    r.waha.fault(limited.name, "ban463");
    expect(await r.sender.sendText({ to: TO(), text: "Kode" })).toEqual({ sessionId: free.id });
    expect(r.waha.sent).toEqual([expect.objectContaining({ session: free.name })]);
    expect(await health(limited.id)).toBe(0);
    expect(await sql`SELECT reachout_until IS NOT NULL AS held, ban_463_count FROM waha_sessions WHERE id = ${limited.id}`).toEqual([{ held: true, ban_463_count: 1 }]);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${limited.id}`).toEqual([]);
    expect(await sql`SELECT severity FROM alerts WHERE dedupe_key = ${`waha_reachout_blocked:${limited.id}`} AND resolved_at IS NULL`).toEqual([{ severity: "critical" }]);
    // The held-back number is now skipped for new contacts; with every number held back the pool says no_number and alerts.
    await sql`UPDATE waha_sessions SET reachout_until = now() + interval '1 hour' WHERE id = ${free.id}`;
    expect(await code(r.sender.sendText({ to: TO(), text: "Kode" }))).toBe("no_number");
    expect(await sql`SELECT severity FROM alerts WHERE kind = 'wa_reachout_blocked' AND dedupe_key = 'wa_reachout_blocked' AND resolved_at IS NULL`).toEqual([{ severity: "critical" }]);
  });

  it("a 475 is the same, counted apart", async () => {
    const r = rig();
    const limited = await createSession({ weight: 5 });
    await createSession();
    r.waha.fault(limited.name, "ban475");
    await r.sender.sendText({ to: TO(), text: "Kode" });
    expect(await sql`SELECT ban_463_count, ban_475_count FROM waha_sessions WHERE id = ${limited.id}`).toEqual([{ ban_463_count: 0, ban_475_count: 1 }]);
    expect(await health(limited.id)).toBe(0);
  });

  it("a held-back number still answers a contact it already has a chat with (not a new contact for it)", async () => {
    const r = rig();
    const held = await createSession();
    const to = TO();
    await sql`UPDATE waha_sessions SET reachout_until = now() + interval '1 hour' WHERE id = ${held.id}`;
    expect(await code(r.sender.sendText({ to, text: "Kode" }))).toBe("no_number");
    await sql`INSERT INTO waha_sends (session_id, kind, contact_key, send_at, created_at) VALUES (${held.id}, 'opener', encode(sha256(convert_to('ebooktrivia/contact/v1|' || ${to}, 'UTF8')), 'hex'), now() - interval '3 days', now() - interval '3 days')`;
    expect(await code(r.sender.sendText({ to, text: "Kode" }))).toBe("sent");
    expect(r.waha.sent).toHaveLength(1);
  });

  it("an abort during the human-like steps (after its slot) sends nothing and leaves no ledger row either", async () => {
    let waits = 0;
    const waha = createWahaFake();
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: waha.access, random: () => 0, sleep: () => (++waits > 1 ? Promise.reject(new Error("aborted")) : Promise.resolve()) });
    const s = await createSession();
    await expect(sender.sendText({ to: TO(), text: "Kode" })).rejects.toMatchObject({ code: "failed" });
    expect(waha.sent).toEqual([]);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${s.id}`).toEqual([]);
  });

  it("takes the share of the new-contact budget a warning leaves from its configuration", async () => {
    const waha = createWahaFake();
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: waha.access, random: () => 0, sleep: () => Promise.resolve(), warningCapFactors: [0.5, 0.25] });
    const s = await createSession();
    await sql`UPDATE waha_sessions SET warning_level = 'first', new_contact_cap = 4 WHERE id = ${s.id}`;
    expect(await sender.sendText({ to: TO(), text: "Kode" })).toEqual({ sessionId: s.id });
  });

  it("an abort during a wait sends nothing and leaves no ledger row", async () => {
    const waha = createWahaFake();
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: waha.access, random: () => 0, sleep: () => Promise.reject(new Error("aborted")) });
    const s = await createSession();
    await expect(sender.sendText({ to: TO(), text: "Kode" })).rejects.toMatchObject({ code: "failed" });
    expect(waha.sent).toEqual([]);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${s.id}`).toEqual([]);
  });
});
