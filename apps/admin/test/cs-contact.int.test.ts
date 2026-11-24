// The customer-service contact (lib/settings/cs-contact.ts) against a real database, as the admin_rw login: validation, the audited save (the number
// and the address as PII references), "nothing changed", the rule that the CS number is never a sending number in BOTH directions (the save, and
// adding or editing a WhatsApp session), and who can reach it (policy; the public and worker logins read the three fields only).
import { isCsEmail, isCsHours, NO_CS_CONTACT } from "@ebooktrivia/core";
import { schema } from "@ebooktrivia/db";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { can, PERMISSIONS } from "../src/lib/policy.ts";
import { CS_NOT_VALID, CS_NUMBER_IS_SENDING, csPreview, getCsContact, parseCsContact, saveCsContact, SENDING_NUMBER_IS_CS } from "../src/lib/settings/cs-contact.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { createWahaServer, createWahaSession, parseWahaServer, parseWahaSession, updateWahaSession } from "../src/lib/settings/waha.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

let rt: ReturnType<typeof newRuntime>;
let ownerId = "";
beforeAll(async () => {
  rt = newRuntime();
  ownerId = (await createTestAdmin(rt, "owner")).userId;
});
beforeEach(async () => {
  await root`DELETE FROM public.cs_contact`;
});
afterAll(async () => {
  await root`DELETE FROM public.cs_contact`;
});

const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);
const phone = (): string => `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
const HOURS = "Senin–Jumat 09.00–17.00 WIB";

async function server(): Promise<string> {
  return as(() => createWahaServer(rt.sql, parseWahaServer({ name: `Server ${suffix()}`, baseUrl: `https://waha-${suffix()}.example.test/` }, { allowPrivateIp: false, active: true })));
}
const session = (serverId: string, number: string) => parseWahaSession({ serverId, sessionName: `s${suffix()}`, phone: number, weight: "1", dailyCap: "10" }, true);

describe("parseCsContact", () => {
  it("normalises the number, lower-cases the address and lets every field be empty", () => {
    expect(parseCsContact(form({ whatsapp: "0812 3456 7890", email: " CS@Contoh.ID ", hours: ` ${HOURS} ` }))).toEqual({ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: HOURS });
    expect(parseCsContact(form({ whatsapp: "", email: "", hours: "" }))).toEqual({ whatsapp: null, email: null, hours: null });
    expect(parseCsContact(form({}))).toEqual({ whatsapp: null, email: null, hours: null });
  });

  it("refuses a malformed number, address or hours with a fixed message that never echoes the input", () => {
    const bad = [
      { whatsapp: "12345", email: "", hours: "" },
      { whatsapp: "", email: "not an address", hours: "" },
      { whatsapp: "", email: "", hours: "x".repeat(81) },
      { whatsapp: "", email: "", hours: "wxyz\nqrst" },
    ];
    for (const values of bad) {
      try {
        parseCsContact(form(values));
        throw new Error("expected InvalidInput");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidInput);
        for (const text of ["12345", "not an address", "xxxxx", "wxyz"]) expect((error as Error).message).not.toContain(text);
      }
    }
  });

  it("accepts hours of exactly 80 characters", () => {
    expect(parseCsContact(form({ hours: "h".repeat(80) })).hours).toBe("h".repeat(80));
  });

  it("refuses invisible and format characters in the hours and a non-ASCII address (the reviewer's probes), without echoing them", () => {
    for (const values of [
      { whatsapp: "", email: "", hours: "Senin\u2028Jumat" },
      { whatsapp: "", email: "", hours: "Senin\u2029Jumat" },
      { whatsapp: "", email: "", hours: "abc\u202efed" },
      { whatsapp: "", email: "", hours: "abc\u200bdef" },
      { whatsapp: "", email: "cs\u202e@x.id", hours: "" },
      { whatsapp: "", email: "c\u0455@x.id", hours: "" },
      { whatsapp: "", email: "a<b>@x.id", hours: "" },
    ]) {
      try {
        parseCsContact(form(values));
        throw new Error(`expected InvalidInput for ${JSON.stringify(values)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidInput);
        expect((error as Error).message).not.toMatch(/[\u2028\u2029\u202e\u200b\u0455<>]|Senin|abc/);
      }
    }
  });
});

describe("the table's CHECKs and the form's checks are one rule", () => {
  it("the hours CHECK is the schema's class, and that class and core isCsHours refuse exactly the same characters over every code point", async () => {
    const [constraint] = await root<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'cs_contact_hours_check'`;
    expect(constraint?.def).toContain(schema.CS_HOURS_FORBIDDEN);
    const refusedByDatabase = new Set(
      (await root<{ g: number }[]>`SELECT g FROM generate_series(1, 1114111) AS g WHERE NOT (g BETWEEN 55296 AND 57343) AND chr(g) ~ ${schema.CS_HOURS_FORBIDDEN}`).map((r) => r.g),
    );
    const refusedByCore = new Set<number>();
    for (let codePoint = 1; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      if (!isCsHours(`a${String.fromCodePoint(codePoint)}b`)) refusedByCore.add(codePoint);
    }
    expect([...refusedByCore].filter((c) => !refusedByDatabase.has(c)).map((c) => c.toString(16))).toEqual([]);
    expect([...refusedByDatabase].filter((c) => !refusedByCore.has(c)).map((c) => c.toString(16))).toEqual([]);
    expect(refusedByCore.size).toBeGreaterThan(200);
  });

  it("the address CHECK and core isCsEmail agree on the probes, and a value the form refuses never reaches the database as a CHECK error in a normal save", async () => {
    const probes = ["cs@contoh.id", "CS@Contoh.ID", "a_b%c+d-e.f@sub-domain.contoh.co.id", "cs\u202e@x.id", "cs@x\u202e.id", "c\u0455@x.id", "a<b>@x.id", 'a"b@x.id', "cs@x.id\n", "cs@x", "cs@@x.id", "cs@x..id", `${"a".repeat(250)}@b.id`];
    for (const probe of probes) {
      const [row] = await root<{ ok: boolean }[]>`SELECT (char_length(${probe}) <= 254 AND ${probe} ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$') AS ok`;
      expect(row?.ok, JSON.stringify(probe)).toBe(isCsEmail(probe));
    }
  });

  it("a value that gets past the form and is refused by a CHECK is a fixed message, not an error page", async () => {
    await expect(as(() => saveCsContact(rt.sql, ownerId, { whatsapp: null, email: null, hours: "Senin\u2028Jumat" }))).rejects.toMatchObject({ name: "InvalidInput", message: CS_NOT_VALID });
    await expect(as(() => saveCsContact(rt.sql, ownerId, { whatsapp: null, email: "cs\u202e@x.id", hours: null }))).rejects.toMatchObject({ name: "InvalidInput", message: CS_NOT_VALID });
    expect(await getCsContact(rt.sql)).toEqual({ whatsapp: null, email: null, hours: null });
  });
});

describe("saving", () => {
  it("shows nothing before anything is saved, stores one row, and audits the change with the number and address as PII", async () => {
    expect(await getCsContact(rt.sql)).toEqual({ whatsapp: null, email: null, hours: null });
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: HOURS }));
    expect(await getCsContact(rt.sql)).toEqual({ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: HOURS });
    const [audit] = await root<{ text: string; pii_refs: string[] }[]>`SELECT row_to_json(a)::text AS text, pii_refs FROM audit_log a WHERE action = 'cs_contact.update' ORDER BY id DESC LIMIT 1`;
    expect(audit).toBeDefined();
    expect(audit?.text).not.toContain("+6281234567890");
    expect(audit?.text).not.toContain("cs@contoh.id");
    expect(audit?.pii_refs.length).toBeGreaterThan(0);
    const [count] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM public.cs_contact`;
    expect(count?.n).toBe(1);
  });

  it("a first save of an empty form changes nothing: no row is inserted and no audit entry is written", async () => {
    const entries = async (): Promise<number> => (await root<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'cs_contact.update'`)[0]?.n ?? 0;
    const before = await entries();
    await expect(as(() => saveCsContact(rt.sql, ownerId, NO_CS_CONTACT))).rejects.toMatchObject({ name: "InvalidInput", message: "Nothing changed." });
    expect((await root`SELECT 1 FROM public.cs_contact`).length).toBe(0);
    expect(await entries()).toBe(before);
  });

  it("can clear every field again (nothing is then shown anywhere), and refuses a save that changes nothing", async () => {
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: "+6281234567890", email: null, hours: null }));
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: null, email: null, hours: null }));
    expect(await getCsContact(rt.sql)).toEqual({ whatsapp: null, email: null, hours: null });
    await expect(as(() => saveCsContact(rt.sql, ownerId, { whatsapp: null, email: null, hours: null }))).rejects.toBeInstanceOf(InvalidInput);
  });

  it("previews the line the WhatsApp replies carry and the two template variables", () => {
    expect(csPreview({ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: HOURS })).toEqual({
      line: "WhatsApp 0812-3456-7890 atau email cs@contoh.id (Senin–Jumat 09\u202400–17\u202400 WIB)",
      csWhatsapp: "0812-3456-7890",
      csEmail: "cs@contoh.id",
    });
    expect(csPreview({ whatsapp: null, email: null, hours: HOURS })).toEqual({ line: null, csWhatsapp: "", csEmail: "" });
  });
});

describe("the CS number is never a sending number", () => {
  it("is refused with a clear message when it is the number of a sending session, active or not, and nothing is written", async () => {
    const number = phone();
    const serverId = await server();
    await as(() => createWahaSession(rt.sql, session(serverId, number)));
    await expect(as(() => saveCsContact(rt.sql, ownerId, { whatsapp: number, email: null, hours: null }))).rejects.toMatchObject({ name: "InvalidInput", message: CS_NUMBER_IS_SENDING });
    expect(await getCsContact(rt.sql)).toEqual({ whatsapp: null, email: null, hours: null });
    // Another number is fine.
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: phone(), email: null, hours: null }));
  });

  it("is refused the other way round: a session added with, or edited to, the CS number is refused with a clear message", async () => {
    const cs = phone();
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: cs, email: null, hours: null }));
    const serverId = await server();
    await expect(as(() => createWahaSession(rt.sql, session(serverId, cs)))).rejects.toMatchObject({ name: "InvalidInput", message: SENDING_NUMBER_IS_CS });
    const sessionId = await as(() => createWahaSession(rt.sql, session(serverId, phone())));
    const edit = session(serverId, cs);
    await expect(as(() => updateWahaSession(rt.sql, sessionId, edit))).rejects.toMatchObject({ name: "InvalidInput", message: SENDING_NUMBER_IS_CS });
    const [row] = await root<{ phone: string }[]>`SELECT phone FROM waha_sessions WHERE id = ${sessionId}`;
    expect(row?.phone).not.toBe(cs);
    // Clearing the CS number frees it for a sending session.
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: null, email: null, hours: null }));
    await as(() => updateWahaSession(rt.sql, sessionId, edit));
    expect((await root<{ phone: string }[]>`SELECT phone FROM waha_sessions WHERE id = ${sessionId}`)[0]?.phone).toBe(cs);
  });

  it("holds against a save and a new session at the same moment: exactly one of the two wins", async () => {
    const number = phone();
    const serverId = await server();
    const outcomes = await Promise.allSettled([
      as(() => saveCsContact(rt.sql, ownerId, { whatsapp: number, email: null, hours: null })),
      as(() => createWahaSession(rt.sql, session(serverId, number))),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(InvalidInput);
    const csHas = (await getCsContact(rt.sql)).whatsapp === number;
    const sessionHas = (await root`SELECT 1 FROM waha_sessions WHERE phone = ${number}`).length > 0;
    expect(csHas !== sessionHas).toBe(true);
    await root`DELETE FROM waha_sessions WHERE phone = ${number}`;
  });
});

describe("who can reach it", () => {
  it("is the Owner's: Staff may not edit it, and the permission exists", () => {
    expect(PERMISSIONS).toContain("cs_contact.edit");
    expect(can("owner", "cs_contact.edit")).toBe(true);
    expect(can("staff", "cs_contact.edit")).toBe(false);
  });

  it("is read by the public login as the three fields only, and written by nobody but the console", async () => {
    await as(() => saveCsContact(rt.sql, ownerId, { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: HOURS }));
    const publicSql = postgres(inject("publicDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
    try {
      expect(await publicSql`SELECT whatsapp, email, hours FROM public.cs_contact`).toEqual([{ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: HOURS }]);
      await expect(publicSql`SELECT updated_by_admin_user_id FROM public.cs_contact`).rejects.toMatchObject({ code: "42501" });
      await expect(publicSql`UPDATE public.cs_contact SET email = NULL`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await publicSql.end({ timeout: 5 });
    }
  });
});
