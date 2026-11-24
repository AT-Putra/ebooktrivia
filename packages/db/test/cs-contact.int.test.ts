// The customer-service contact (migration 0027): the single row and its checks, the grants (public_rw and worker_rw read the three
// fields only, admin_rw writes), and the rule that the CS WhatsApp number is never a sending number, from both sides (ET190).
import { afterEach, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState, suffix } from "./db.ts";

type Id = { id: string };

const phone = (): string => `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;

afterEach(async () => {
  await sql`DELETE FROM cs_contact`;
});

async function newSession(number: string | null): Promise<string> {
  const server = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`W${suffix()}`}, 'https://waha.invalid/', 'waha.invalid') RETURNING id`);
  return first(await sql<Id[]>`INSERT INTO waha_sessions (server_id, session_name, phone) VALUES (${server.id}, ${`s${suffix()}`}, ${number}) RETURNING id`).id;
}

describe("cs_contact table", () => {
  it("holds one row at most and checks the number, the address and the hours", async () => {
    await sql`INSERT INTO cs_contact (id, whatsapp, email, hours) VALUES (1, '+6281234567890', 'cs@contoh.id', 'Senin-Jumat 09.00-17.00 WIB')`;
    expect(await sqlState(sql`INSERT INTO cs_contact (id) VALUES (2)`)).toBe("23514");
    expect(await sqlState(sql`UPDATE cs_contact SET whatsapp = '0812'`)).toBe("23514");
    expect(await sqlState(sql`UPDATE cs_contact SET whatsapp = '+628412345678'`)).toBe("23514");
    expect(await sqlState(sql`UPDATE cs_contact SET email = 'no address'`)).toBe("23514");
    expect(await sqlState(sql`UPDATE cs_contact SET hours = ${"x".repeat(81)}`)).toBe("23514");
    expect(await sqlState(sql`UPDATE cs_contact SET hours = ''`)).toBe("23514");
    expect(await sqlState(sql`UPDATE cs_contact SET hours = ${"line one\nline two"}`)).toBe("23514");
    await sql`UPDATE cs_contact SET whatsapp = NULL, email = NULL, hours = NULL`;
  });

  it("refuses invisible and format characters in the hours: line and paragraph separators, bidi marks, zero-width, soft hyphen, BOM, C1 controls", async () => {
    await sql`INSERT INTO cs_contact (id) VALUES (1)`;
    for (const probe of ["Senin\u2028Jumat", "Senin\u2029Jumat", "abc\u202efed", "abc\u200bdef", "abc\u200edef", "abc\u2066def", "abc\u00addef", "\ufeffabc", "abc\u0085def", "abc\u007fdef", "abc\tdef", "a\u{e0041}b", "a\u{1d173}b", "a\u{110bd}b"]) {
      expect(await sqlState(sql`UPDATE cs_contact SET hours = ${probe}`), JSON.stringify(probe)).toBe("23514");
    }
    // Visible text in other scripts, and no-break and ideographic spaces, is fine.
    for (const ok of ["Senin–Jumat 09.00–17.00 WIB", "月〜金 9:00–17:00", "Senin\u00a0Jumat", "Senin\u3000Jumat", "é ö ñ", "x".repeat(80)]) await sql`UPDATE cs_contact SET hours = ${ok}`;
  });

  it("holds an ASCII address only: a bidi override, a lookalike letter, markup or a quote is refused", async () => {
    await sql`INSERT INTO cs_contact (id) VALUES (1)`;
    for (const bad of ["cs\u202e@x.id", "cs@x\u202e.id", "c\u0455@x.id", "cs@exämple.id", "a<b>@x.id", 'a"b@x.id', "a'b@x.id", "cs@x.id\n", "cs@x.id ", "cs@@x.id", "cs@x..id", "cs@x", `${"a".repeat(250)}@b.id`]) {
      expect(await sqlState(sql`UPDATE cs_contact SET email = ${bad}`), JSON.stringify(bad)).toBe("23514");
    }
    for (const ok of ["cs@contoh.id", "CS@Contoh.ID", "a_b%c+d-e.f@sub-domain.contoh.co.id"]) await sql`UPDATE cs_contact SET email = ${ok}`;
  });
});

describe("who can reach cs_contact", () => {
  it("admin_rw writes it; public_rw and worker_rw read only the key, whatsapp, email and hours (WHERE id = 1 works) and write nothing", async () => {
    await asRole("admin_rw", (tx) => tx`INSERT INTO public.cs_contact (id, whatsapp, email, hours, updated_by_admin_user_id) VALUES (1, '+6281234567890', 'cs@contoh.id', 'Setiap hari', 'admin-1')`);
    for (const role of ["public_rw", "worker_rw"] as const) {
      const [row] = await asRole(role, (tx) => tx<{ whatsapp: string; email: string; hours: string }[]>`SELECT whatsapp, email, hours FROM public.cs_contact WHERE id = 1`);
      expect(row).toEqual({ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Setiap hari" });
      // Who edited it, and when, stays with the console (no SELECT * either: the table-level read is not granted).
      expect(await sqlState(asRole(role, (tx) => tx`SELECT updated_by_admin_user_id FROM public.cs_contact`))).toBe("42501");
      expect(await sqlState(asRole(role, (tx) => tx`SELECT * FROM public.cs_contact`))).toBe("42501");
      expect(await sqlState(asRole(role, (tx) => tx`UPDATE public.cs_contact SET email = NULL`))).toBe("42501");
      expect(await sqlState(asRole(role, (tx) => tx`DELETE FROM public.cs_contact`))).toBe("42501");
    }
    expect(await sqlState(asRole("internal_rw", (tx) => tx`SELECT whatsapp FROM public.cs_contact`))).toBe("42501");
  });
});

describe("the CS number is never a sending number (ET190)", () => {
  it("refuses the number of a sending session, active or not, for the console and for the owner", async () => {
    const number = phone();
    await newSession(number);
    for (const role of ["admin_rw", "migrator"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`INSERT INTO public.cs_contact (id, whatsapp) VALUES (1, ${number})`))).toBe("ET190");
    }
    // Another number, and an empty one, are fine; then moving it onto a sending number is refused too.
    await sql`INSERT INTO cs_contact (id, whatsapp) VALUES (1, ${phone()})`;
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.cs_contact SET whatsapp = ${number}`))).toBe("ET190");
    await sql`UPDATE cs_contact SET whatsapp = NULL`;
  });

  it("refuses a sending session that is added with, or edited to, the CS number, and lets any other number through", async () => {
    const cs = phone();
    await sql`INSERT INTO cs_contact (id, whatsapp) VALUES (1, ${cs})`;
    const other = await newSession(phone());
    const server = first(await sql<Id[]>`SELECT server_id AS id FROM waha_sessions WHERE id = ${other}`);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.waha_sessions (server_id, session_name, phone) VALUES (${server.id}, ${`s${suffix()}`}, ${cs})`))).toBe("ET190");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.waha_sessions SET phone = ${cs} WHERE id = ${other}`))).toBe("ET190");
    expect(await sqlState(sql`UPDATE waha_sessions SET phone = ${cs} WHERE id = ${other}`)).toBe("ET190");
    // A session without a number, a changed weight on a session, and another number are not affected.
    await asRole("admin_rw", (tx) => tx`INSERT INTO public.waha_sessions (server_id, session_name) VALUES (${server.id}, ${`s${suffix()}`})`);
    await asRole("admin_rw", (tx) => tx`UPDATE public.waha_sessions SET weight = 3, phone = ${phone()} WHERE id = ${other}`);
  });

  it("holds when the two writes race: one of them waits for the other and is then refused", async () => {
    const number = phone();
    const server = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`W${suffix()}`}, 'https://waha.invalid/', 'waha.invalid') RETURNING id`);
    const saveCs = sql.begin(async (tx) => {
      await tx`INSERT INTO cs_contact (id, whatsapp) VALUES (1, ${number})`;
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const addSession = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return sqlState(sql`INSERT INTO waha_sessions (server_id, session_name, phone) VALUES (${server.id}, ${`s${suffix()}`}, ${number})`);
    })();
    await saveCs;
    expect(await addSession).toBe("ET190");
  });

  // Under REPEATABLE READ / SERIALIZABLE the check would read the transaction's old snapshot: a session or a CS number committed after it would go unseen
  // even with the lock held. Like the content-lock and prize-tier guards, both triggers refuse to run there (ET021), whoever writes.
  it.each(["repeatable read", "serializable"])("is refused outside READ COMMITTED, from both sides (ET021, %s)", async (level) => {
    const isolation = `isolation level ${level}`;
    const server = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`W${suffix()}`}, 'https://waha.invalid/', 'waha.invalid') RETURNING id`);
    const number = phone();
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.cs_contact (id, whatsapp) VALUES (1, ${number})`, isolation))).toBe("ET021");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.waha_sessions (server_id, session_name, phone) VALUES (${server.id}, ${`s${suffix()}`}, ${number})`, isolation))).toBe("ET021");
    expect(await sqlState(asRole("migrator", (tx) => tx`INSERT INTO public.cs_contact (id, whatsapp) VALUES (1, ${number})`, isolation))).toBe("ET021");
    // Nothing was written, and the same writes pass under READ COMMITTED.
    expect((await sql`SELECT 1 FROM cs_contact`).length).toBe(0);
    await asRole("admin_rw", (tx) => tx`INSERT INTO public.cs_contact (id, whatsapp) VALUES (1, ${number})`);
  });
});
