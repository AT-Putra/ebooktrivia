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
});

describe("who can reach cs_contact", () => {
  it("admin_rw writes it; public_rw and worker_rw read only whatsapp, email and hours and write nothing", async () => {
    await asRole("admin_rw", (tx) => tx`INSERT INTO public.cs_contact (id, whatsapp, email, hours, updated_by_admin_user_id) VALUES (1, '+6281234567890', 'cs@contoh.id', 'Setiap hari', 'admin-1')`);
    for (const role of ["public_rw", "worker_rw"] as const) {
      const [row] = await asRole(role, (tx) => tx<{ whatsapp: string; email: string; hours: string }[]>`SELECT whatsapp, email, hours FROM public.cs_contact`);
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
});
