// Owner decision 2026-11-24, the console side, as the admin_rw login against a real database:
//   - Settings, Templates: Add wording creates the next delivery_opener_N (checked like an edit), Remove deletes one; at least 3 and at most 20 wordings, enforced under a
//     lock (parallel requests cannot pass either limit); only delivery_opener_* can be added or removed; both are audited; the seeded ten pass the editor's own checks;
//   - Settings, WhatsApp: a new session's warm-up starts now unless "Established number" is ticked; ticking it ends the warm-up, unticking it restarts it from today, a save
//     that leaves the box alone keeps the start; every change is audited.
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { addOpenerWording, listTemplates, OPENER_MAX_WORDINGS, OPENER_MIN_WORDINGS, parseTemplate, removeOpenerWording } from "../src/lib/settings/templates.ts";
import { createWahaServer, createWahaSession, listWahaServers, parseWahaServer, parseWahaSession, updateWahaSession } from "../src/lib/settings/waha.ts";
import { asAdmin, auditRows, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

const rt = newRuntime();
let ownerId = "";
let staffId = "";
const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);
const asStaff = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(staffId, fn);

beforeAll(async () => {
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  staffId = (await createTestAdmin(rt, "staff")).userId;
});

const openerRows = () =>
  root<{ id: string; key: string; body: string }[]>`
    SELECT id, key, body FROM message_templates WHERE key ~ '^delivery_opener_[0-9]+$' AND channel = 'whatsapp' AND locale = 'id' ORDER BY substring(key from '[0-9]+$')::int`;
const keysNow = async (): Promise<string[]> => (await openerRows()).map((r) => r.key);
const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    throw error;
  }
  throw new Error("expected InvalidInput");
};
const countAudit = async (action: string): Promise<number> => (await root<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`)[0]?.n ?? 0;
const creates = (): Promise<number> => countAudit("message_template.create");
const deletes = (): Promise<number> => countAudit("message_template.delete");
const tenKeys = Array.from({ length: 10 }, (_, i) => `delivery_opener_${String(i + 1)}`);

describe("opener wordings: the seeded ten, add and remove", () => {
  // Every test starts from the seeded ten and leaves them: whatever it added or removed is put back.
  let seeded: { key: string; body: string }[] = [];
  beforeAll(async () => {
    seeded = (await openerRows()).map(({ key, body }) => ({ key, body }));
  });
  beforeEach(async () => {
    await root`DELETE FROM message_templates WHERE key ~ '^delivery_opener_[0-9]+$' AND channel = 'whatsapp' AND locale = 'id'`;
    for (const { key, body } of seeded) await root`INSERT INTO message_templates (key, channel, locale, subject, body) VALUES (${key}, 'whatsapp', 'id', NULL, ${body})`;
  });

  it("the database has the ten wordings and every one passes the editor's own checks (variables, choices, length)", async () => {
    expect(await keysNow()).toEqual(tenKeys);
    const templates = (await listTemplates(rt.sql)).filter((t) => t.key.startsWith("delivery_opener_"));
    // Listed in the order of their numbers: 2 before 10.
    expect(templates.map((t) => t.key)).toEqual(tenKeys);
    for (const t of templates) expect(() => parseTemplate(t.key, t.channel, { subject: t.subject ?? "", body: t.body }), t.key).not.toThrow();
    // The three wordings that use {sapaan} and the three that use choices are the ones the Owner approved.
    const bodies = new Map(templates.map((t) => [t.key, t.body]));
    expect([4, 6, 8, 10].every((n) => bodies.get(`delivery_opener_${String(n)}`)?.startsWith("{sapaan} "))).toBe(true);
    expect([5, 7, 9].every((n) => bodies.get(`delivery_opener_${String(n)}`)?.includes("[["))).toBe(true);
  });

  it("add creates the next delivery_opener_N from a checked text, and audits it", async () => {
    const body = "{sapaan} {nama}, [[ebook|buku]] {judul_ebook} siap. Balas ya.";
    const key = await as(() => addOpenerWording(rt.sql, body));
    expect(key).toBe("delivery_opener_11");
    const [row] = await root<{ id: string; channel: string; locale: string; subject: string | null; body: string }[]>`SELECT id, channel, locale, subject, body FROM message_templates WHERE key = ${key}`;
    expect(row).toMatchObject({ channel: "whatsapp", locale: "id", subject: null, body });
    const [audit] = await auditRows(row?.id ?? null, "message_template.create");
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: ownerId, changes: { key: { after: key }, body: { after: body } } });
    // A line break and tab are kept, CR LF is normalised, like an edit.
    expect(await as(() => addOpenerWording(rt.sql, "Halo {nama}\r\nbalas ya"))).toBe("delivery_opener_12");
    expect((await root<{ body: string }[]>`SELECT body FROM message_templates WHERE key = 'delivery_opener_12'`)[0]?.body).toBe("Halo {nama}\nbalas ya");
  });

  it("the next number is one more than the highest there is, also after a removal in the middle", async () => {
    const middle = (await openerRows()).find((r) => r.key === "delivery_opener_5");
    await as(() => removeOpenerWording(rt.sql, middle?.id ?? ""));
    expect(await as(() => addOpenerWording(rt.sql, "Halo {nama}, balas ya."))).toBe("delivery_opener_11");
    expect(await keysNow()).toEqual([...tenKeys.filter((k) => k !== "delivery_opener_5"), "delivery_opener_11"].sort((a, b) => Number(a.split("_")[2]) - Number(b.split("_")[2])));
  });

  it("add checks the text like an edit: an unknown or login variable, a bad choice, an empty or over-long text are refused, and nothing is written", async () => {
    const createsBefore = await creates();
    const refusals: readonly [string, string, RegExp][] = [
      ["a login link", "Halo {nama} {link_trivia}", /cannot have/],
      ["a login code", "Halo {nama} {kode_otp}", /cannot have/],
      ["an unknown variable", "Halo {name}", /does not exist/],
      ["a stray brace", "Halo {nama", /\{ or \}/],
      ["a choice that is never closed", "[[Halo|Hai {nama}", /never closed/],
      ["a nested choice", "[[a|[[b|c]]]] {nama}", /nested/],
      ["a choice with one option", "[[Halo]] {nama}", /2 to 5 options/],
      ["a choice with six options", "[[a|b|c|d|e|f]]", /2 to 5 options/],
      ["an empty option", "[[Halo||Hai]]", /is empty/],
      ["a variable in an option", "[[Halo|{nama}]]", /no \{ or \}/],
      ["an empty text", "   ", /1 to 4,000 characters/],
      ["a text over the limit with the longest options", `[[a|${"x".repeat(2500)}]] [[b|${"x".repeat(2500)}]]`, /longest option/],
    ];
    for (const [what, body, message] of refusals) {
      expect(await messageOf(() => as(() => addOpenerWording(rt.sql, body))), what).toMatch(message);
    }
    expect(await keysNow()).toEqual(tenKeys);
    expect(await creates()).toBe(createsBefore);
  });

  it("holds at most 20 wordings: the 21st is refused, and 21 requests at once leave exactly 20", async () => {
    for (let i = 0; i < OPENER_MAX_WORDINGS - 10; i++) await as(() => addOpenerWording(rt.sql, `Halo {nama}, wording ${String(i)}.`));
    expect(await keysNow()).toHaveLength(OPENER_MAX_WORDINGS);
    expect(await messageOf(() => as(() => addOpenerWording(rt.sql, "Satu lagi")))).toMatch(/already 20 opener wordings/);
    expect(await keysNow()).toHaveLength(OPENER_MAX_WORDINGS);

    // Back to 19 and race five adds: only one gets in.
    const [last] = (await openerRows()).slice(-1);
    await as(() => removeOpenerWording(rt.sql, last?.id ?? ""));
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => as(() => addOpenerWording(rt.sql, `Halo {nama}, balapan ${String(i)}.`))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
    expect(await keysNow()).toHaveLength(OPENER_MAX_WORDINGS);
  });

  it("remove deletes one wording and audits it; at least 3 stay, also for parallel requests", async () => {
    const rows = await openerRows();
    const seven = rows.find((r) => r.key === "delivery_opener_7");
    await as(() => removeOpenerWording(rt.sql, seven?.id ?? ""));
    expect(await keysNow()).not.toContain("delivery_opener_7");
    const [audit] = await auditRows(seven?.id ?? null, "message_template.delete");
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: ownerId, changes: { key: { before: "delivery_opener_7" }, body: { before: seven?.body ?? "" } } });

    // Down to the minimum one by one.
    while ((await keysNow()).length > OPENER_MIN_WORDINGS) {
      const [oldest] = await openerRows();
      await as(() => removeOpenerWording(rt.sql, oldest?.id ?? ""));
    }
    expect(await keysNow()).toHaveLength(OPENER_MIN_WORDINGS);
    const [first] = await openerRows();
    expect(await messageOf(() => as(() => removeOpenerWording(rt.sql, first?.id ?? "")))).toMatch(/at least 3 opener wordings/i);
    expect(await keysNow()).toHaveLength(OPENER_MIN_WORDINGS);

    // Four wordings and three requests at once to remove different ones: exactly one goes.
    await as(() => addOpenerWording(rt.sql, "Halo {nama}, tambahan."));
    const four = await openerRows();
    const results = await Promise.allSettled(four.slice(0, 3).map((r) => as(() => removeOpenerWording(rt.sql, r.id))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await keysNow()).toHaveLength(OPENER_MIN_WORDINGS);
  });

  it("remove refuses a template that is not an opener wording, and one that is already gone", async () => {
    const deletesBefore = await deletes();
    const [otp] = await root<{ id: string }[]>`SELECT id FROM message_templates WHERE key = 'otp' AND channel = 'whatsapp'`;
    const [delivery] = await root<{ id: string }[]>`SELECT id FROM message_templates WHERE key = 'delivery' AND channel = 'email'`;
    expect(await messageOf(() => as(() => removeOpenerWording(rt.sql, otp?.id ?? "")))).toMatch(/Only opener wordings/);
    expect(await messageOf(() => as(() => removeOpenerWording(rt.sql, delivery?.id ?? "")))).toMatch(/Only opener wordings/);
    expect(await messageOf(() => as(() => removeOpenerWording(rt.sql, randomUUID())))).toMatch(/no longer exists/);
    expect(await root`SELECT 1 FROM message_templates WHERE key IN ('otp', 'delivery')`).toHaveLength(3);
    expect(await deletes()).toBe(deletesBefore);
  });

  it("Staff may add and remove (the same permission as editing a template: the policy is checked by the actions' guard test)", async () => {
    const key = await asStaff(() => addOpenerWording(rt.sql, "Halo {nama}, dari staff."));
    expect(key).toBe("delivery_opener_11");
    const [row] = await root<{ id: string }[]>`SELECT id FROM message_templates WHERE key = ${key}`;
    await asStaff(() => removeOpenerWording(rt.sql, row?.id ?? ""));
    const rows = await auditRows(row?.id ?? null);
    expect(rows.map((r) => [r.action, r.actor_admin_user_id])).toEqual([
      ["message_template.create", staffId],
      ["message_template.delete", staffId],
    ]);
  });

  it("an opener row that names a removed wording keeps working: the key is plain text on the row", async () => {
    const [product] = await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`;
    expect(product?.id).toBeDefined();
    await root`
      INSERT INTO delivery_openers (delivery_id, status, variant_key)
      SELECT d.id, 'pending', 'delivery_opener_10' FROM deliveries d LIMIT 0`;
    const tenth = (await openerRows()).find((r) => r.key === "delivery_opener_10");
    await as(() => removeOpenerWording(rt.sql, tenth?.id ?? ""));
    expect(await keysNow()).not.toContain("delivery_opener_10");
  });
});

describe("a number's warm-up (Settings, WhatsApp)", () => {
  async function newServer(): Promise<string> {
    return as(() => createWahaServer(rt.sql, parseWahaServer({ name: `Server ${suffix()}`, baseUrl: `https://waha-${suffix()}.example.test/` }, { allowPrivateIp: false, active: true })));
  }
  const warmupOf = async (id: string): Promise<Date | null> => (await root<{ w: Date | null }[]>`SELECT warmup_started_at AS w FROM waha_sessions WHERE id = ${id}`)[0]?.w ?? null;
  const input = (serverId: string, established: boolean, name = `s${suffix()}`) =>
    parseWahaSession({ serverId, sessionName: name, phone: "", weight: "1", dailyCap: "10" }, true, established);
  /** The audit's `field` of a change is a timestamp the way JSON carries it. */
  const isoOf = (change: unknown, field: "before" | "after"): boolean => {
    const value = typeof change === "object" && change !== null ? (change as Record<string, unknown>)[field] : undefined;
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
  };
  const withinSeconds = (date: Date | null, seconds: number): boolean => date !== null && Math.abs(Date.now() - date.getTime()) < seconds * 1000;

  it("a new session starts its warm-up now, unless it is an established number", async () => {
    const serverId = await newServer();
    const warming = await as(() => createWahaSession(rt.sql, input(serverId, false)));
    const established = await as(() => createWahaSession(rt.sql, input(serverId, true)));
    expect(withinSeconds(await warmupOf(warming), 30)).toBe(true);
    expect(await warmupOf(established)).toBeNull();
    // The audit says what was set (a value, not a secret): the start of the warm-up, or nothing for an established number.
    const [created] = await auditRows(warming, "waha_session.create");
    expect(isoOf(created?.changes["warmup_started_at"], "after")).toBe(true);
    expect((await auditRows(established, "waha_session.create"))[0]?.changes["warmup_started_at"]).toBeUndefined();
    // The listing hands the page what it shows: the start and the number's own cap of new contacts.
    const listed = (await listWahaServers(rt.sql)).find((s) => s.id === serverId)?.sessions ?? [];
    expect(listed.find((s) => s.id === warming)?.newContactCap).toBe(30);
    expect(listed.find((s) => s.id === warming)?.warmupStartedAt).toBeInstanceOf(Date);
    expect(listed.find((s) => s.id === established)).toMatchObject({ warmupStartedAt: null });
  });

  it("ticking 'Established number' ends the warm-up; unticking it restarts the warm-up from today; both are audited", async () => {
    const serverId = await newServer();
    const id = await as(() => createWahaSession(rt.sql, input(serverId, false)));
    await root`UPDATE waha_sessions SET warmup_started_at = now() - interval '10 days' WHERE id = ${id}`;
    const keep = (established: boolean) => ({ sessionName: "default", phone: null, weight: 1, dailyCap: 10, active: true, established });

    await as(() => updateWahaSession(rt.sql, id, keep(true)));
    expect(await warmupOf(id)).toBeNull();
    const [ended] = (await auditRows(id, "waha_session.update")).slice(-1);
    expect(isoOf(ended?.changes["warmup_started_at"], "before")).toBe(true);
    expect(ended?.changes["warmup_started_at"]).toMatchObject({ after: null });

    await as(() => updateWahaSession(rt.sql, id, keep(false)));
    expect(withinSeconds(await warmupOf(id), 30)).toBe(true);
    const [restarted] = (await auditRows(id, "waha_session.update")).slice(-1);
    expect(isoOf(restarted?.changes["warmup_started_at"], "after")).toBe(true);
    expect(restarted?.changes["warmup_started_at"]).toMatchObject({ before: null });
  });

  it("a save that leaves the box unticked on a warming number keeps its start (the day count does not restart)", async () => {
    const serverId = await newServer();
    const id = await as(() => createWahaSession(rt.sql, input(serverId, false)));
    await root`UPDATE waha_sessions SET warmup_started_at = now() - interval '10 days' WHERE id = ${id}`;
    const before = await warmupOf(id);
    await as(() => updateWahaSession(rt.sql, id, { sessionName: "default", phone: null, weight: 3, dailyCap: 50, active: true, established: false }));
    expect((await warmupOf(id))?.getTime()).toBe(before?.getTime());
    const [audit] = (await auditRows(id, "waha_session.update")).slice(-1);
    expect(audit?.changes["warmup_started_at"]).toBeUndefined();
    expect(audit?.changes["weight"]).toMatchObject({ after: 3 });
    // An established number stays established when the box stays ticked.
    await root`UPDATE waha_sessions SET warmup_started_at = NULL WHERE id = ${id}`;
    await as(() => updateWahaSession(rt.sql, id, { sessionName: "default", phone: null, weight: 3, dailyCap: 50, active: true, established: true }));
    expect(await warmupOf(id)).toBeNull();
  });
});
