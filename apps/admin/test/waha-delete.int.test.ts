// Deleting WAHA servers and sessions that were never used (Owner only), as the admin_rw login against a real database:
//   - a session goes only when no row anywhere names it (deliveries, openers, their failover history, the send ledger, inbound messages,
//     template test sends, a reserved send slot) AND it is inactive; a server goes with its sessions and its sealed API key in ONE transaction,
//     only when none of its sessions is used or active;
//   - the row is locked and the rules are checked again under the lock: a reference still in flight is seen (clean "in use", never a 500),
//     a session added meanwhile is seen too;
//   - the audit rows carry ids and names, never the base URL, the host or the key; Staff are refused (policy) and nothing changes.
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { beforeAll, describe, expect, it } from "vitest";
import { decide } from "../src/lib/access.ts";
import type { Tx } from "../src/lib/audit.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { NO_SETTINGS, type SettingsConfig } from "../src/lib/settings/env.ts";
import {
  createWahaServer,
  createWahaSession,
  deleteWahaServer,
  deleteWahaSession,
  listWahaServers,
  parseWahaServer,
  parseWahaSession,
  SERVER_IN_USE,
  SERVER_STILL_ACTIVE,
  SESSION_IN_USE,
  SESSION_STILL_ACTIVE,
  setWahaApiKey,
  updateWahaSession,
} from "../src/lib/settings/waha.ts";
import { asAdmin, auditRows, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

const pairs = { payment: generateScopeKeyPair(), messaging: generateScopeKeyPair(), conversions: generateScopeKeyPair() };
const sealer = createSecretSealer({ payment: pairs.payment.publicKey, messaging: pairs.messaging.publicKey, conversions: pairs.conversions.publicKey });
const settings: SettingsConfig = { ...NO_SETTINGS, sealer };
const rt = newRuntime(undefined, settings);

let ownerId = "";
let shop: { productId: string; programId: string; landingPageId: string };
const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);
const keyOf = (): string => `waha-${suffix()}-${suffix()}-${suffix()}`;

beforeAll(async () => {
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  const [product] = await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`;
  const [program] = await root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${`wd-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`;
  const [lp] = await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program?.id ?? ""}) RETURNING id`;
  shop = { productId: product?.id ?? "", programId: program?.id ?? "", landingPageId: lp?.id ?? "" };
});

/** A server (HTTPS host unique per call) with one session per entry of `active` (inactive when false). */
async function fixture(active: readonly boolean[], options: { readonly key?: boolean; readonly serverActive?: boolean } = {}) {
  const host = `waha-${suffix()}.example.test`;
  const serverId = await as(() => createWahaServer(rt.sql, parseWahaServer({ name: `Server ${suffix()}`, baseUrl: `https://${host}/` }, { allowPrivateIp: false, active: options.serverActive ?? true })));
  const sessions: { id: string; name: string }[] = [];
  for (const isActive of active) {
    const name = `s${suffix()}`;
    const id = await as(() => createWahaSession(rt.sql, parseWahaSession({ serverId, sessionName: name, phone: "", weight: "1", dailyCap: "10" }, isActive)));
    sessions.push({ id, name });
  }
  const key = options.key === true ? keyOf() : null;
  if (key !== null) await as(() => setWahaApiKey(rt.sql, settings, serverId, key));
  return { serverId, host, sessions, key };
}

const exists = async (table: "waha_servers" | "waha_sessions", id: string): Promise<boolean> => (await root`SELECT 1 FROM ${root(table)} WHERE id = ${id}`).length > 0;
const secretExists = async (serverId: string): Promise<boolean> => (await root`SELECT 1 FROM settings_secrets WHERE name = ${SECRET_NAMES.wahaApiKey(serverId)}`).length > 0;
const auditText = async (action: string, entityId: string): Promise<string[]> =>
  (await root<{ text: string }[]>`SELECT row_to_json(a)::text AS text FROM audit_log a WHERE action = ${action} AND entity_id = ${entityId} ORDER BY id`).map((r) => r.text);
const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** A WhatsApp delivery of a new paid order, optionally already naming a session (current or in the failover history). */
async function whatsappDelivery(options: { readonly sessionId?: string; readonly tried?: readonly string[] } = {}): Promise<string> {
  const [order] = await root<{ id: string }[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, expires_at)
    VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`${suffix()}${suffix()}`.toUpperCase()}, ${shop.landingPageId}, ${shop.programId}, ${shop.productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid',
            sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, now() + interval '1 day') RETURNING id`;
  await root`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order?.id ?? ""}`;
  const [row] = await root<{ id: string }[]>`
    INSERT INTO deliveries (order_id, channel, status, attempts, session_id, tried_session_ids)
    VALUES (${order?.id ?? ""}, 'whatsapp', 'failed', 1, ${options.sessionId ?? null}, ${[...(options.tried ?? [])]}::uuid[]) RETURNING id`;
  return row?.id ?? "";
}

/** An inbound WhatsApp message the way the public webhook stores it: the session name, no session id. */
const inboundByName = (name: string) => root`INSERT INTO waha_inbound (message_id, session_name, from_jid, raw) VALUES (${`m-${suffix()}${suffix()}`}, ${name}, '6281200000000@c.us', '{}')`;

/**
 * Runs `work` in a transaction of its own and keeps that transaction open, then starts `attempt` and checks that it is still waiting after
 * 400 ms (blocked by the open transaction, not slipped past it), commits, and returns how `attempt` ended (the error, or undefined).
 */
async function whileHeld(work: (tx: Tx) => Promise<unknown>, attempt: () => Promise<unknown>): Promise<unknown> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let worked: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    worked = resolve;
  });
  const holder = root.begin(async (tx) => {
    await work(tx);
    worked();
    await gate;
  });
  await Promise.race([done, holder]);
  let settled = false;
  const outcome = rejection(attempt).finally(() => {
    settled = true;
  });
  await sleep(400);
  expect(settled, "the attempt waits for the open transaction, it does not slip past it").toBe(false);
  release();
  await holder;
  return outcome;
}

/** What the database raises when a reference slips past the checks: ON DELETE RESTRICT raises restrict_violation (23001), NO ACTION foreign_key_violation (23503). */
const REFUSALS = ["restrict_violation", "foreign_key_violation"] as const;

/** Makes the database refuse the delete of this session with that error (as if a reference slipped past the checks), for `run`. */
async function withForeignKeyRefusal(sessionId: string, condition: (typeof REFUSALS)[number], run: () => Promise<void>): Promise<void> {
  await root.unsafe(`
    CREATE FUNCTION public.waha_delete_test_refusal() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.id = '${sessionId}'::uuid THEN RAISE ${condition} USING MESSAGE = 'test: still referenced'; END IF;
      RETURN OLD;
    END
    $fn$`);
  await root`CREATE TRIGGER waha_delete_test_refusal BEFORE DELETE ON public.waha_sessions FOR EACH ROW EXECUTE FUNCTION public.waha_delete_test_refusal()`;
  try {
    await run();
  } finally {
    await root`DROP TRIGGER waha_delete_test_refusal ON public.waha_sessions`;
    await root`DROP FUNCTION public.waha_delete_test_refusal()`;
  }
}

/** One way a session can be referenced: the row that makes it "used". */
const REFERENCES: readonly (readonly [string, (id: string, name: string) => Promise<unknown>])[] = [
  ["deliveries.session_id", (id) => whatsappDelivery({ sessionId: id })],
  ["deliveries.tried_session_ids (failover history)", (id) => whatsappDelivery({ tried: [id] })],
  ["delivery_openers.session_id", async (id) => root`INSERT INTO delivery_openers (delivery_id, status, attempts, session_id) VALUES (${await whatsappDelivery()}, 'sent', 1, ${id})`],
  ["delivery_openers.tried_session_ids (failover history)", async (id) => root`INSERT INTO delivery_openers (delivery_id, status, attempts, tried_session_ids) VALUES (${await whatsappDelivery()}, 'failed', 1, ${[id]}::uuid[])`],
  ["waha_sends", async (id) => root`INSERT INTO waha_sends (session_id, kind) VALUES (${id}, 'otp')`],
  // As the webhook writes it (apps/public webhooks/waha.ts): the session NAME only, waha_inbound.session_id stays NULL.
  ["waha_inbound (by session name, session_id NULL as the webhook stores it)", async (_id, name) => inboundByName(name)],
  ["waha_inbound.session_id", async (id, name) => root`INSERT INTO waha_inbound (message_id, session_id, session_name, from_jid, raw) VALUES (${`m-${suffix()}${suffix()}`}, ${id}, ${name}, '6281200000000@c.us', '{}')`],
  [
    "template_test_sends",
    async (id) => root`
      INSERT INTO template_test_sends (template_id, channel, recipient, waha_session_id, requested_by_admin_user_id, status)
      SELECT t.id, 'whatsapp', '+6281234567890', ${id}, ${ownerId}, 'sent' FROM message_templates t WHERE t.channel = 'whatsapp' LIMIT 1`,
  ],
  // waha_sends is pruned after 31 days; the slot the pool once reserved on the number stays.
  ["a reserved send slot (waha_sessions.next_send_at, after the send ledger was pruned)", async (id) => root`UPDATE waha_sessions SET next_send_at = now() WHERE id = ${id}`],
];

describe("deleting a session", () => {
  it("removes an unused, inactive session, audited by id and name only", async () => {
    const { serverId, host, sessions } = await fixture([false]);
    const [session] = sessions;
    await as(() => deleteWahaSession(rt.sql, session?.id ?? ""));
    expect(await exists("waha_sessions", session?.id ?? "")).toBe(false);
    expect(await exists("waha_servers", serverId)).toBe(true);
    const rows = await auditText("waha_session.delete", session?.id ?? "");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toContain(session?.name);
    expect(row).toContain(serverId);
    expect(row).not.toContain(host);
    expect(row).not.toContain("https://");
    const [audit] = await auditRows(session?.id ?? "", "waha_session.delete");
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: ownerId, changes: { session_name: { before: session?.name }, server_id: serverId } });
  });

  it("refuses an active session, and one that no longer exists", async () => {
    const { sessions } = await fixture([true]);
    const [session] = sessions;
    const error = await rejection(() => as(() => deleteWahaSession(rt.sql, session?.id ?? "")));
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as InvalidInput).message).toBe(SESSION_STILL_ACTIVE);
    expect(await exists("waha_sessions", session?.id ?? "")).toBe(true);
    expect(await auditText("waha_session.delete", session?.id ?? "")).toHaveLength(0);
    const gone = await rejection(() => as(() => deleteWahaSession(rt.sql, randomUUID())));
    expect((gone as InvalidInput).message).toBe("This session no longer exists.");
  });

  it.each(REFERENCES)("refuses a session that has history: %s (and nothing changes)", async (_label, reference) => {
    const { sessions } = await fixture([false]);
    const [session] = sessions;
    await reference(session?.id ?? "", session?.name ?? "");
    const error = await rejection(() => as(() => deleteWahaSession(rt.sql, session?.id ?? "")));
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as InvalidInput).message).toBe(SESSION_IN_USE);
    expect(await exists("waha_sessions", session?.id ?? "")).toBe(true);
    expect(await auditText("waha_session.delete", session?.id ?? "")).toHaveLength(0);
  });

  it("an in-flight reference (another transaction inserted a send, not committed yet) is waited for and then refused cleanly", async () => {
    const { sessions } = await fixture([false]);
    const id = sessions[0]?.id ?? "";
    const error = await whileHeld((tx) => tx`INSERT INTO waha_sends (session_id, kind) VALUES (${id}, 'otp')`, () => as(() => deleteWahaSession(rt.sql, id)));
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as InvalidInput).message).toBe(SESSION_IN_USE);
    expect(await exists("waha_sessions", id)).toBe(true);
  });

  // No foreign key stands behind this one: only the row lock and the re-check under it catch it (remove either and the session is deleted).
  it("a send slot reserved by the worker while the delete waits (UPDATE next_send_at, as claimSession does) is seen by the re-check under the lock", async () => {
    const { sessions } = await fixture([false]);
    const id = sessions[0]?.id ?? "";
    const error = await whileHeld((tx) => tx`UPDATE public.waha_sessions SET next_send_at = now() WHERE id = ${id}`, () => as(() => deleteWahaSession(rt.sql, id)));
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as InvalidInput).message).toBe(SESSION_IN_USE);
    expect(await exists("waha_sessions", id)).toBe(true);
    expect(await auditText("waha_session.delete", id)).toHaveLength(0);
  });

  it("counts a same-named session's inbound history too (the webhook stores only the session name, so a number on another server with that name is used)", async () => {
    const { sessions } = await fixture([false]);
    const other = await fixture([false]);
    const [session] = sessions;
    const [twin] = other.sessions;
    // The twin: the same session name on another server, with inbound history stored by name.
    const twinId = await as(() => createWahaSession(rt.sql, parseWahaSession({ serverId: other.serverId, sessionName: session?.name ?? "", phone: "", weight: "1", dailyCap: "10" }, false)));
    await inboundByName(session?.name ?? "");
    for (const id of [session?.id ?? "", twinId]) {
      const error = await rejection(() => as(() => deleteWahaSession(rt.sql, id)));
      expect((error as InvalidInput).message, id).toBe(SESSION_IN_USE);
      expect(await exists("waha_sessions", id)).toBe(true);
    }
    // A session with another name is not touched by it.
    await as(() => deleteWahaSession(rt.sql, twin?.id ?? ""));
    expect(await exists("waha_sessions", twin?.id ?? "")).toBe(false);
  });

  it.each(REFUSALS)("answers 'in use' when the database itself refuses the delete with %s (never a 500)", async (condition) => {
    const { sessions } = await fixture([false]);
    const [session] = sessions;
    await withForeignKeyRefusal(session?.id ?? "", condition, async () => {
      const error = await rejection(() => as(() => deleteWahaSession(rt.sql, session?.id ?? "")));
      expect(error).toBeInstanceOf(InvalidInput);
      expect((error as InvalidInput).message).toBe(SESSION_IN_USE);
      expect(await exists("waha_sessions", session?.id ?? "")).toBe(true);
    });
  });

  it("untick Active and save, then it can go (the page's two steps)", async () => {
    const { serverId, sessions } = await fixture([true]);
    const [session] = sessions;
    await as(() => updateWahaSession(rt.sql, session?.id ?? "", { sessionName: session?.name ?? "", phone: null, weight: 1, dailyCap: 10, active: false, established: false }));
    const listed = (await listWahaServers(rt.sql)).find((s) => s.id === serverId)?.sessions[0];
    expect(listed).toMatchObject({ active: false, used: false });
    await as(() => deleteWahaSession(rt.sql, session?.id ?? ""));
    expect(await exists("waha_sessions", session?.id ?? "")).toBe(false);
  });
});

describe("deleting a server", () => {
  it("removes an unused server with its inactive sessions AND its sealed API key, in one go, audited without the URL, host or key", async () => {
    const { serverId, host, sessions, key } = await fixture([false, false], { key: true });
    const [secret] = await root<{ id: string }[]>`SELECT id FROM settings_secrets WHERE name = ${SECRET_NAMES.wahaApiKey(serverId)}`;
    expect(secret).toBeDefined();
    await as(() => deleteWahaServer(rt.sql, serverId));
    expect(await exists("waha_servers", serverId)).toBe(false);
    for (const s of sessions) expect(await exists("waha_sessions", s.id)).toBe(false);
    expect(await secretExists(serverId), "the sealed key row is gone, not orphaned").toBe(false);
    expect(await root`SELECT 1 FROM settings_secrets WHERE id = ${secret?.id ?? ""}`).toHaveLength(0);
    const [serverAudit] = await auditRows(serverId, "waha_server.delete");
    expect(serverAudit?.changes).toMatchObject({ name: { before: expect.stringMatching(/^Server /) as unknown }, sessions_deleted: 2, api_key_deleted: true });
    const [serverRow] = await auditText("waha_server.delete", serverId);
    const sessionRows = (await Promise.all(sessions.map((s) => auditText("waha_session.delete", s.id)))).flat();
    expect(sessionRows).toHaveLength(2);
    const cleared = await auditText("settings_secret.clear", secret?.id ?? "");
    expect(cleared).toHaveLength(1);
    // Everything this delete wrote: no host, no URL, no key.
    const everything = [serverRow, ...sessionRows, ...cleared].join("\n");
    expect(everything).not.toContain(host);
    expect(everything).not.toContain("https://");
    expect(everything).not.toContain(key ?? "no key");
    expect(everything).toContain(sessions[0]?.name);
  });

  it("a server with no session at all can be deleted directly, active or not", async () => {
    for (const serverActive of [true, false]) {
      const { serverId } = await fixture([], { serverActive });
      await as(() => deleteWahaServer(rt.sql, serverId));
      expect(await exists("waha_servers", serverId)).toBe(false);
    }
  });

  it("refuses a server that has a session with history: nothing is deleted, not the other sessions, not the key", async () => {
    const { serverId, sessions } = await fixture([false, false], { key: true });
    await root`INSERT INTO waha_sends (session_id, kind) VALUES (${sessions[1]?.id ?? ""}, 'otp')`;
    const error = await rejection(() => as(() => deleteWahaServer(rt.sql, serverId)));
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as InvalidInput).message).toBe(SERVER_IN_USE);
    expect(await exists("waha_servers", serverId)).toBe(true);
    for (const s of sessions) expect(await exists("waha_sessions", s.id)).toBe(true);
    expect(await secretExists(serverId)).toBe(true);
    expect(await auditText("waha_server.delete", serverId)).toHaveLength(0);
    expect((await listWahaServers(rt.sql)).find((s) => s.id === serverId)).toMatchObject({ used: true });
  });

  it("refuses a server that still has an active session (even one never used)", async () => {
    const { serverId, sessions } = await fixture([false, true], { key: true });
    const error = await rejection(() => as(() => deleteWahaServer(rt.sql, serverId)));
    expect((error as InvalidInput).message).toBe(SERVER_STILL_ACTIVE);
    expect(await exists("waha_servers", serverId)).toBe(true);
    for (const s of sessions) expect(await exists("waha_sessions", s.id)).toBe(true);
    expect(await secretExists(serverId)).toBe(true);
    expect((await listWahaServers(rt.sql)).find((s) => s.id === serverId)).toMatchObject({ used: false });
  });

  it("a session added while the delete is waiting for the server lock is seen by the re-check", async () => {
    const { serverId, sessions } = await fixture([false], { key: true });
    const error = await whileHeld(
      (tx) => tx`INSERT INTO waha_sessions (server_id, session_name, active) VALUES (${serverId}, ${`late${suffix()}`}, true)`,
      () => as(() => deleteWahaServer(rt.sql, serverId)),
    );
    expect((error as InvalidInput).message).toBe(SERVER_STILL_ACTIVE);
    expect(await exists("waha_servers", serverId)).toBe(true);
    expect(await exists("waha_sessions", sessions[0]?.id ?? "")).toBe(true);
    expect(await secretExists(serverId)).toBe(true);
  });

  it("a send slot reserved on one of its sessions while the delete waits is seen under the session locks: nothing is deleted, not the key", async () => {
    const { serverId, sessions } = await fixture([false, false], { key: true });
    const id = sessions[1]?.id ?? "";
    const error = await whileHeld((tx) => tx`UPDATE public.waha_sessions SET next_send_at = now() WHERE id = ${id}`, () => as(() => deleteWahaServer(rt.sql, serverId)));
    expect((error as InvalidInput).message).toBe(SERVER_IN_USE);
    expect(await exists("waha_servers", serverId)).toBe(true);
    for (const s of sessions) expect(await exists("waha_sessions", s.id)).toBe(true);
    expect(await secretExists(serverId)).toBe(true);
    expect(await auditText("waha_server.delete", serverId)).toHaveLength(0);
  });

  it.each(REFUSALS)("answers 'in use' when the database refuses with %s, and then the key and the sessions are still there (one transaction)", async (condition) => {
    const { serverId, sessions } = await fixture([false], { key: true });
    await withForeignKeyRefusal(sessions[0]?.id ?? "", condition, async () => {
      const error = await rejection(() => as(() => deleteWahaServer(rt.sql, serverId)));
      expect((error as InvalidInput).message).toBe(SERVER_IN_USE);
      expect(await exists("waha_servers", serverId)).toBe(true);
      expect(await exists("waha_sessions", sessions[0]?.id ?? "")).toBe(true);
      expect(await secretExists(serverId)).toBe(true);
    });
  });
});

describe("what the page is told", () => {
  it("lists used / unused per session and per server", async () => {
    const { serverId, sessions } = await fixture([false, false]);
    await inboundByName(sessions[0]?.name ?? "");
    const server = (await listWahaServers(rt.sql)).find((s) => s.id === serverId);
    expect(server?.used).toBe(true);
    expect(server?.sessions.map((s) => [s.id === sessions[0]?.id, s.used]).sort()).toEqual([
      [false, false],
      [true, true],
    ]);
  });
});

describe("who may delete", () => {
  it("is the Owner's alone (waha.edit): Staff are refused 403 by the guard and a signed-out browser is sent to the login", async () => {
    const staffId = (await createTestAdmin(rt, "staff")).userId;
    const identity = (role: "owner" | "staff") => ({ userId: role === "owner" ? ownerId : staffId, sessionId: "s", role, displayName: "x" });
    expect(decide({ status: "active", admin: identity("owner") }, { permission: "waha.edit" })).toMatchObject({ kind: "allow" });
    expect(decide({ status: "active", admin: identity("staff") }, { permission: "waha.edit" })).toEqual({ kind: "forbidden" });
    expect(decide({ status: "anonymous" }, { permission: "waha.edit" })).toEqual({ kind: "redirect", to: "/login" });
  });
});
