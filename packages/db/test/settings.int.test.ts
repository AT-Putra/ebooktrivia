// US-017 (M5a-2) database guarantees behind the admin settings:
//   - program field lock after the first PAID order (ET047) and extend-only reschedule (ET048),
//     for every writer, including the trivia set count and order;
//   - SMTP / WAHA secrets bound to exactly their endpoint host (ET062), the SMTP password cleared
//     when the host changes;
//   - admin_rw can read no decryptable form (sealed secrets, sealed OTP codes, outbox sealed);
//   - template test-sends: the worker records the outcome only; public_rw has no access.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asRole, bytes, first, sql, sqlState, suffix, type Tx } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

type Id = { id: string };

async function paidOrder(programId: string, productId: string): Promise<string> {
  const landingPageId = await createLandingPage(programId);
  const row = orderRow({ landingPageId, programId, productId });
  const { id } = first(await sql<Id[]>`INSERT INTO orders ${sql(row)} RETURNING id`);
  await asRole("worker_rw", (tx) => tx`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${id}`);
  return id;
}

const lockedAt = async (programId: string): Promise<Date | null> =>
  first(await sql<{ locked_at: Date | null }[]>`SELECT locked_at FROM programs WHERE id = ${programId}`).locked_at;

describe("program field lock (plan §10 item 10)", () => {
  it("an unlocked program can be edited freely, including shortening its dates", async () => {
    const { programId } = await createProgram();
    await asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.programs
           SET sales_start_at = sales_start_at - interval '1 day', sales_end_at = sales_end_at - interval '2 days',
               grace_days = 10, slug = ${`moved-${suffix()}`}
         WHERE id = ${programId}`,
    );
    expect(await lockedAt(programId)).toBeNull();
  });

  it("the first PAID order stamps locked_at in its own transaction", async () => {
    const { programId, productId } = await createProgram();
    expect(await lockedAt(programId)).toBeNull();
    await paidOrder(programId, productId);
    expect(await lockedAt(programId)).toBeInstanceOf(Date);
  });

  it.each([
    ["product", "product_id = (SELECT id FROM public.products WHERE id <> p.product_id LIMIT 1)"],
    ["slug", "slug = 'renamed-slug'"],
    ["sales start", "sales_start_at = sales_start_at + interval '1 hour'"],
    ["locked_at cleared", "locked_at = NULL"],
    ["locked_at moved", "locked_at = locked_at - interval '1 day'"],
  ])("refuses a change of %s once locked, for admin_rw, the owner and superusers (ET047)", async (_what, set) => {
    await createProgram(); // a second product to point at
    const { programId, productId } = await createProgram();
    await paidOrder(programId, productId);
    const statement = `UPDATE public.programs p SET ${set} WHERE p.id = $1`;
    for (const role of ["admin_rw", "migrator"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx.unsafe(statement, [programId])))).toBe("ET047");
    }
    expect(await sqlState(sql.unsafe(statement, [programId]))).toBe("ET047");
  });

  it.each([
    ["sales end moved earlier", "sales_end_at = sales_end_at - interval '1 minute'"],
    ["grace shortened", "grace_days = grace_days - 1"],
  ])("reschedule is extend-only once locked: %s (ET048)", async (_what, set) => {
    const { programId, productId } = await createProgram();
    await paidOrder(programId, productId);
    expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(`UPDATE public.programs SET ${set} WHERE id = $1`, [programId])))).toBe("ET048");
  });

  it("allows extending sales end and grace, and editing the unlocked fields, once locked", async () => {
    const { programId, productId } = await createProgram();
    await paidOrder(programId, productId);
    const before = first(await sql<{ sales_end_at: Date; locked_at: Date }[]>`SELECT sales_end_at, locked_at FROM programs WHERE id = ${programId}`);
    await asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.programs
           SET sales_end_at = sales_end_at + interval '7 days', grace_days = grace_days + 5, name = 'Renamed',
               default_points = 20, leaderboard_top_n = 25, updated_at = now()
         WHERE id = ${programId}`,
    );
    const after = first(await sql<{ sales_end_at: Date; grace_days: number; locked_at: Date }[]>`SELECT sales_end_at, grace_days, locked_at FROM programs WHERE id = ${programId}`);
    expect(after.sales_end_at.getTime() - before.sales_end_at.getTime()).toBe(7 * 86_400_000);
    expect(after.grace_days).toBe(35);
    expect(after.locked_at).toEqual(before.locked_at);
  });

  it("locks even without the stamp when a paid order exists (and stamps it)", async () => {
    const { programId, productId } = await createProgram();
    await paidOrder(programId, productId);
    // A superuser can bypass the trigger only by disabling it; simulate a missed stamp that way.
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE programs DISABLE TRIGGER programs_field_lock`;
      await tx`UPDATE programs SET locked_at = NULL WHERE id = ${programId}`;
      await tx`ALTER TABLE programs ENABLE ALWAYS TRIGGER programs_field_lock`;
    });
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.programs SET sales_end_at = sales_end_at - interval '1 day' WHERE id = ${programId}`))).toBe("ET048");
    await asRole("admin_rw", (tx) => tx`UPDATE public.programs SET name = 'Stamped' WHERE id = ${programId}`);
    expect(await lockedAt(programId)).toBeInstanceOf(Date);
  });

  it("freezes the trivia set count and order once locked; set titles stay editable", async () => {
    const { programId, productId } = await createProgram();
    const { id: setId } = first(await sql<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'Set 1') RETURNING id`);
    await paidOrder(programId, productId);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.trivia_sets (program_id, position, title) VALUES (${programId}, 2, 'Set 2')`))).toBe("ET047");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.trivia_sets WHERE id = ${setId}`))).toBe("ET047");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.trivia_sets SET position = 5 WHERE id = ${setId}`))).toBe("ET047");
    const other = await createProgram();
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.trivia_sets SET program_id = ${other.programId} WHERE id = ${setId}`))).toBe("ET047");
    // Into a locked program from an unlocked one.
    const { id: freeSet } = first(await sql<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${other.programId}, 1, 'Free') RETURNING id`);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.trivia_sets SET program_id = ${programId}, position = 9 WHERE id = ${freeSet}`))).toBe("ET047");
    await asRole("admin_rw", (tx) => tx`UPDATE public.trivia_sets SET title = 'Typo fixed' WHERE id = ${setId}`);
  });

  it.each(["admin_rw", "migrator", null] as const)("a locked program cannot go back to draft (ET047) as %s", async (role) => {
    const { programId, productId } = await createProgram();
    await paidOrder(programId, productId);
    const statement = (tx: Pick<Tx, "unsafe">) => tx.unsafe("UPDATE public.programs SET status = 'draft' WHERE id = $1", [programId]);
    expect(await sqlState(role === null ? statement(sql) : asRole(role, statement))).toBe("ET047");
  });

  it("an unlocked published program can go back to draft", async () => {
    const { programId } = await createProgram();
    await asRole("admin_rw", (tx) => tx`UPDATE public.programs SET status = 'draft' WHERE id = ${programId}`);
  });

  it.each([
    ["awaiting_confirmation", false],
    ["finalized", false],
    ["awaiting_confirmation", true],
  ] as const)("an ended program (%s, locked %s) cannot be rescheduled at all (ET048), for every writer", async (status, locked) => {
    const { programId, productId } = await createProgram();
    if (locked) await paidOrder(programId, productId);
    await sql`UPDATE programs SET status = ${status} WHERE id = ${programId}`;
    for (const set of ["sales_end_at = sales_end_at + interval '1 day'", "grace_days = grace_days + 1"]) {
      const statement = (tx: Pick<Tx, "unsafe">) => tx.unsafe(`UPDATE public.programs SET ${set} WHERE id = $1`, [programId]);
      for (const role of ["admin_rw", "migrator"] as const) expect(await sqlState(asRole(role, statement)), `${role} ${set}`).toBe("ET048");
      expect(await sqlState(statement(sql)), set).toBe("ET048");
    }
    await asRole("admin_rw", (tx) => tx`UPDATE public.programs SET name = 'Still editable' WHERE id = ${programId}`);
  });

  it("an unlocked program's sets can be added, reordered and deleted, and the program deleted with them", async () => {
    const { programId } = await createProgram();
    await asRole("admin_rw", async (tx) => {
      await tx`INSERT INTO public.trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'A'), (${programId}, 2, 'B')`;
      await tx`UPDATE public.trivia_sets SET position = position + 10 WHERE program_id = ${programId}`;
      await tx`DELETE FROM public.programs WHERE id = ${programId}`;
    });
    expect(await sql`SELECT 1 FROM trivia_sets WHERE program_id = ${programId}`).toHaveLength(0);
  });
});

async function smtpRow(host: string): Promise<void> {
  await sql`DELETE FROM smtp_settings`;
  await sql`INSERT INTO smtp_settings (host, port, security, from_address) VALUES (${host}, 587, 'starttls', 'noreply@example.test')`;
}

async function insertSecret(row: { scope: string; name: string; bound_host: string | null }): Promise<string> {
  const id = randomUUID();
  await asRole(
    "admin_rw",
    (tx) => tx`
      INSERT INTO public.settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${id}, ${row.scope}, ${row.name}, NULL, ${row.bound_host}, ${bytes(40)}, ${bytes(12)}, ${bytes(80)}, ${`${suffix()}${suffix()}`}, '')`,
  );
  return id;
}

const secretExists = async (id: string): Promise<boolean> => (await sql`SELECT 1 FROM settings_secrets WHERE id = ${id}`).length === 1;

describe("SMTP and WAHA secret endpoint binding (ET062)", () => {
  // One file runs its tests in order; smtp_settings is a single row.
  it("smtp.password must be a messaging secret bound to the SMTP host", async () => {
    await smtpRow("smtp.example.test");
    await sql`DELETE FROM settings_secrets WHERE name = 'smtp.password'`;
    expect(await sqlState(insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "evil.example.test" }))).toBe("ET062");
    expect(await sqlState(insertSecret({ scope: "messaging", name: "smtp.password", bound_host: null }))).toBe("ET062");
    expect(await sqlState(insertSecret({ scope: "payment", name: "smtp.password", bound_host: "smtp.example.test" }))).toBe("ET062");
    const id = await insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "smtp.example.test" });
    // Re-binding the row to another host is refused too (with a fresh encryption, so not ET060).
    expect(
      await sqlState(
        asRole(
          "admin_rw",
          (tx) => tx`UPDATE public.settings_secrets SET bound_host = 'evil.example.test', ciphertext = ${bytes(40)}, nonce = ${bytes(12)}, sealed_dek = ${bytes(80)} WHERE id = ${id}`,
        ),
      ),
    ).toBe("ET062");
    expect(await secretExists(id)).toBe(true);
  });

  it("refuses an SMTP password when no SMTP server is configured", async () => {
    await sql`DELETE FROM smtp_settings`;
    expect(await sqlState(insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "smtp.example.test" }))).toBe("ET062");
  });

  it("deletes the SMTP password when the host, port or TLS mode changes or the row is deleted, keeps it on other changes", async () => {
    await smtpRow("smtp.example.test");
    const id = await insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "smtp.example.test" });
    await asRole("admin_rw", (tx) => tx`UPDATE public.smtp_settings SET username = 'mailer', from_name = 'Toko', updated_at = now()`);
    expect(await secretExists(id)).toBe(true);
    // Security review US-017 INFO 6: another port / TLS mode may be another service.
    await asRole("admin_rw", (tx) => tx`UPDATE public.smtp_settings SET port = 465, security = 'tls'`);
    expect(await secretExists(id)).toBe(false);
    const viaPort = await insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "smtp.example.test" });
    await asRole("admin_rw", (tx) => tx`UPDATE public.smtp_settings SET port = 587, security = 'starttls'`);
    expect(await secretExists(viaPort)).toBe(false);
    const viaHost = await insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "smtp.example.test" });
    await asRole("admin_rw", (tx) => tx`UPDATE public.smtp_settings SET host = 'mail.other.test'`);
    expect(await secretExists(viaHost)).toBe(false);
    const again = await insertSecret({ scope: "messaging", name: "smtp.password", bound_host: "mail.other.test" });
    await asRole("admin_rw", (tx) => tx`DELETE FROM public.smtp_settings`);
    expect(await secretExists(again)).toBe(false);
  });

  it("a WAHA API key must be bound to its own server's base_url_host", async () => {
    const server = first(
      await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W', 'https://waha.example.test:3000/', 'waha.example.test:3000') RETURNING id`,
    );
    const other = first(
      await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('X', 'https://other.example.test/', 'other.example.test') RETURNING id`,
    );
    const name = `waha.${server.id.replaceAll("-", "")}.api_key`;
    expect(await sqlState(insertSecret({ scope: "messaging", name, bound_host: "other.example.test" }))).toBe("ET062");
    expect(await sqlState(insertSecret({ scope: "messaging", name: `waha.${randomUUID().replaceAll("-", "")}.api_key`, bound_host: "waha.example.test:3000" }))).toBe("ET062");
    expect(await sqlState(insertSecret({ scope: "payment", name, bound_host: "waha.example.test:3000" }))).toBe("ET062");
    const id = await insertSecret({ scope: "messaging", name, bound_host: "waha.example.test:3000" });
    expect(await secretExists(id)).toBe(true);
    // The other server's host cannot carry this server's key either way round.
    expect(await sqlState(insertSecret({ scope: "messaging", name: `waha.${other.id.replaceAll("-", "")}.api_key`, bound_host: "waha.example.test:3000" }))).toBe("ET062");
  });
});

describe("endpoint checks (US-017 review)", () => {
  it("SMTP: TLS goes with port 465 and STARTTLS with any other (23514)", async () => {
    await sql`DELETE FROM smtp_settings`;
    for (const [port, security] of [[465, "starttls"], [587, "tls"]] as const) {
      expect(await sqlState(sql`INSERT INTO smtp_settings (host, port, security, from_address) VALUES ('smtp.example.test', ${port}, ${security}, 'a@example.test')`)).toBe("23514");
    }
  });

  it("the private-IP allowlist is valid for IPv4 literals only (security review S3)", async () => {
    await sql`DELETE FROM smtp_settings`;
    expect(await sqlState(sql`INSERT INTO smtp_settings (host, port, security, from_address, allow_private_ip) VALUES ('smtp.example.test', 587, 'starttls', 'a@example.test', true)`)).toBe("23514");
    await sql`INSERT INTO smtp_settings (host, port, security, from_address, allow_private_ip) VALUES ('10.1.2.3', 587, 'starttls', 'a@example.test', true)`;
    await sql`DELETE FROM smtp_settings`;
    expect(await sqlState(sql`INSERT INTO waha_servers (name, base_url, base_url_host, allow_private_ip) VALUES ('W', 'https://waha.example.test/', 'waha.example.test', true)`)).toBe("23514");
    await sql`INSERT INTO waha_servers (name, base_url, base_url_host, allow_private_ip) VALUES ('W', 'https://10.1.2.3:3000/', '10.1.2.3:3000', true)`;
  });
});

describe("admin_rw reads no decryptable form (plan M2.3: the admin process cannot decrypt)", () => {
  it.each([
    ["settings_secrets.ciphertext", "SELECT ciphertext FROM public.settings_secrets"],
    ["settings_secrets.nonce", "SELECT nonce FROM public.settings_secrets"],
    ["settings_secrets.sealed_dek", "SELECT sealed_dek FROM public.settings_secrets"],
    ["settings_secrets *", "SELECT * FROM public.settings_secrets"],
    ["outbox.sealed", "SELECT sealed FROM public.outbox"],
    ["outbox *", "SELECT * FROM public.outbox"],
    ["player_otps.sealed_code", "SELECT sealed_code FROM public.player_otps"],
    ["player_otps.mac", "SELECT mac FROM public.player_otps"],
    ["get_payment_secret()", "SELECT * FROM public.get_payment_secret()"],
    ["a sealed column through RETURNING", "UPDATE public.settings_secrets SET last4 = last4 WHERE false RETURNING sealed_dek"],
    ["a sealed column read in an UPDATE", "UPDATE public.settings_secrets SET last4 = '' WHERE ciphertext IS NOT NULL"],
  ])("cannot read %s (42501)", async (_what, statement) => {
    expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });

  it("can read the labels and last4, and write, replace and delete secrets", async () => {
    const id = await insertSecret({ scope: "payment", name: `midtrans.sandbox.server_key_${suffix()}`, bound_host: null });
    await asRole("admin_rw", async (tx) => {
      const rows = await tx`SELECT id, scope, name, adnet_id, bound_host, key_id, last4, created_at, updated_at FROM public.settings_secrets WHERE id = ${id}`;
      expect(rows).toHaveLength(1);
      await tx`UPDATE public.settings_secrets SET ciphertext = ${bytes(40)}, nonce = ${bytes(12)}, sealed_dek = ${bytes(80)}, last4 = 'abcd', updated_at = now() WHERE id = ${id}`;
      await tx`DELETE FROM public.settings_secrets WHERE id = ${id}`;
    });
    expect(await secretExists(id)).toBe(false);
  });

  it("can still enqueue outbox rows and read their state", async () => {
    const id = randomUUID();
    await asRole("admin_rw", async (tx) => {
      await tx`INSERT INTO public.outbox (id, topic, dedupe_key, payload) VALUES (${id}, 'template.test_send', ${`template.test_send:${id}`}, '{}'::jsonb)`;
      const [row] = await tx<{ topic: string }[]>`SELECT topic, processed_at, last_error FROM public.outbox WHERE id = ${id}`;
      expect(row?.topic).toBe("template.test_send");
    });
    await sql`DELETE FROM outbox WHERE id = ${id}`;
  });
});

describe("template test-sends", () => {
  async function testSend(channel: "email" | "whatsapp", recipient: string): Promise<string> {
    const template = first(
      await sql<Id[]>`INSERT INTO message_templates (key, channel, body) VALUES (${`t_${suffix()}`}, ${channel}, 'Halo {nama}') RETURNING id`,
    );
    const { id } = first(
      await sql<Id[]>`
        INSERT INTO template_test_sends (template_id, channel, recipient, requested_by_admin_user_id)
        VALUES (${template.id}, ${channel}, ${recipient}, 'admin-1') RETURNING id`,
    );
    return id;
  }

  it("the worker records the outcome but cannot change what or to whom", async () => {
    const id = await testSend("email", "owner@example.test");
    await asRole("worker_rw", (tx) => tx`UPDATE public.template_test_sends SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = ${id} AND status = 'pending'`);
    for (const set of ["recipient = 'x@example.test'", "template_id = template_id", "channel = 'email'", "waha_session_id = NULL"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx.unsafe(`UPDATE public.template_test_sends SET ${set} WHERE id = $1`, [id])))).toBe("42501");
    }
    expect(await sqlState(asRole("worker_rw", (tx) => tx`DELETE FROM public.template_test_sends WHERE id = ${id}`))).toBe("42501");
  });

  it("public_rw and internal_rw have no access to test-sends, upload sessions or SMTP settings", async () => {
    for (const role of ["public_rw", "internal_rw"] as const) {
      for (const table of ["template_test_sends", "upload_sessions", "smtp_settings"]) {
        expect(await sqlState(asRole(role, (tx) => tx.unsafe(`SELECT 1 FROM public.${table}`))), `${role} ${table}`).toBe("42501");
      }
    }
    expect(await sqlState(asRole("worker_rw", (tx) => tx`SELECT 1 FROM public.upload_sessions`))).toBe("42501");
  });

  it("test recipients are admin only", async () => {
    for (const role of ["public_rw", "internal_rw", "worker_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT 1 FROM public.test_recipients`)), role).toBe("42501");
    }
    await asRole("admin_rw", (tx) => tx`SELECT 1 FROM public.test_recipients`);
  });

  it("checks the recipient per channel", async () => {
    expect(await sqlState(testSend("whatsapp", "0812345678"))).toBe("23514");
    expect(await sqlState(testSend("email", "not an address"))).toBe("23514");
    await testSend("whatsapp", "+6281234567890");
  });
});
