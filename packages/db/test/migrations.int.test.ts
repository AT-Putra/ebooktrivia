// Upgrade paths of existing databases.
//   - Security review US-011 #15: migration 0001 pins player_otps.sealed_code to exactly 54
//     bytes. A dev/staging database created before US-011 can still hold short-lived OTP rows
//     sealed under the old 48..128-byte rule; 0001 must delete those rows first instead of failing
//     the whole migration on ADD CONSTRAINT.
//   - US-013: 0003 adds the lp_domains NOTIFY trigger to a database deployed at 0002.
//   - US-018: 0009 truncates sub-millisecond answer / finish timestamps before its CHECKs.
//   - US-020: 0012 backfills orders.buyer_key on existing orders before making it NOT NULL.
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";
import { runMigrations } from "../src/migrate.ts";
import { databaseUrl, serverUrl } from "./env.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const onnotice = (): undefined => undefined;

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** A migrations folder holding migrations 0000..`last` only, i.e. the schema of an older deploy. */
function migrationsUpTo(last: number): string {
  const dir = mkdtempSync(join(tmpdir(), "ebt-mig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(packageRoot, "migrations", "meta", "_journal.json"), "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  for (const { tag } of journal.entries) cpSync(join(packageRoot, "migrations", `${tag}.sql`), join(dir, `${tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

/** Creates a database and applies roles, preflight and the drizzle migrations in `folder` as migrator. */
async function deployOld(name: string, folder: string, seed: (sql: postgres.Sql) => Promise<void> = () => Promise.resolve()): Promise<void> {
  const old = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
  try {
    await old.unsafe(readFileSync(join(packageRoot, "sql", "roles.sql"), "utf8"));
    await old.unsafe(readFileSync(join(packageRoot, "sql", "preflight.sql"), "utf8"));
    await old.unsafe("SET ROLE migrator");
    await old.unsafe("SET search_path = public");
    await migrate(drizzle(old), { migrationsFolder: folder });
    await old.unsafe("RESET ROLE");
    await seed(old);
  } finally {
    await old.end();
  }
}

describe("upgrading a pre-US-011 database", () => {
  it("0001 deletes OTP rows that are not 54 bytes instead of failing, and keeps valid ones", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(0);
    try {
      // The first deploy, exactly as src/migrate.ts ran it at the time: roles, preflight, then
      // the drizzle migrations as migrator (owner of every object).
      await deployOld(name, folder, async (old) => {
        // 72 and 128 bytes were valid under 0000 (48..128); 54 is the post-US-011 size.
        for (const [phone, size] of [
          ["+6281234567890", 72],
          ["+6281234567891", 128],
          ["+6281234567892", 54],
        ] as const) {
          await old`
            INSERT INTO player_otps (phone, mac, sealed_code, expires_at)
            VALUES (${phone}, ${randomBytes(32)}, ${randomBytes(size)}, now() + interval '5 minutes')`;
        }
      });

      await runMigrations(databaseUrl(name)); // applies 0001, 0002, ... and the sql/ files

      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        const rows = await check<{ phone: string; n: number }[]>`
          SELECT phone, octet_length(sealed_code) AS n FROM player_otps ORDER BY phone`;
        expect(rows).toEqual([{ phone: "+6281234567892", n: 54 }]);
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

describe("upgrading a pre-US-013 database", () => {
  it("0003 adds the lp_domains NOTIFY trigger, enabled ALWAYS, to a database deployed at 0002", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(2);
    try {
      await deployOld(name, folder);
      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      const triggers = () =>
        check<{ name: string; enabled: string }[]>`
          SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger
          WHERE tgrelid = 'public.lp_domains'::regclass AND NOT tgisinternal`;
      try {
        expect(await triggers()).toEqual([]);
        await runMigrations(databaseUrl(name)); // applies 0003 and the sql/ files
        expect(await triggers()).toEqual([{ name: "lp_domains_notify", enabled: "A" }]);
        await runMigrations(databaseUrl(name)); // and stays re-runnable
        expect(await triggers()).toEqual([{ name: "lp_domains_notify", enabled: "A" }]);
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

describe("upgrading a pre-US-017 database", () => {
  it("0007 locks programs that already have a paid order at their first paid_at, and stays put on re-runs", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(6);
    const first = new Date("2027-04-02T03:00:00.000Z");
    const later = new Date("2027-04-05T09:30:00.000Z");
    try {
      // deployOld's connection went through drizzle, which leaves Date parameters unserialised:
      // timestamps are passed as ISO strings.
      await deployOld(name, folder, async (old) => {
        const [product] = await old<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('E', 49000) RETURNING id`;
        for (const slug of ["sold", "unsold"]) {
          const [program] = await old<{ id: string }[]>`
            INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
            VALUES (${product?.id ?? ""}, ${slug}, ${slug}, 'published', '2027-04-01', '2027-07-01', 30) RETURNING id`;
          const [lp] = await old<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${slug}${randomBytes(6).toString("hex")}`}, 'LP', ${program?.id ?? ""}) RETURNING id`;
          const orders: [string, Date | null][] = slug === "sold" ? [["paid", later], ["paid", first], ["pending", null]] : [["pending", null]];
          for (const [status, paidAt] of orders) {
            await old`
              INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, amount_idr, expires_at, status, paid_at)
              VALUES (${randomBytes(10).toString("hex")}, ${randomBytes(5).toString("hex").toUpperCase()}, ${lp?.id ?? ""}, ${program?.id ?? ""}, ${product?.id ?? ""},
                      'B', '+6281234567890', 'b@example.invalid', 49000, now() + interval '1 day', ${status}, ${paidAt?.toISOString() ?? null})`;
          }
        }
      });
      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      const locks = () => check<{ slug: string; locked_at: Date | null }[]>`SELECT slug, locked_at FROM programs ORDER BY slug`;
      try {
        expect(await locks()).toEqual([
          { slug: "sold", locked_at: null },
          { slug: "unsold", locked_at: null },
        ]);
        await runMigrations(databaseUrl(name)); // applies 0007, 0008 and the sql/ files
        expect(await locks()).toEqual([
          { slug: "sold", locked_at: first },
          { slug: "unsold", locked_at: null },
        ]);
        await runMigrations(databaseUrl(name));
        expect(await locks()).toEqual([
          { slug: "sold", locked_at: first },
          { slug: "unsold", locked_at: null },
        ]);
        // And from now on the lock holds (triggers.sql applied after the migrations).
        await expect(check`UPDATE programs SET grace_days = 1 WHERE slug = 'sold'`).rejects.toMatchObject({ code: "ET048" });
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

describe("upgrading a pre-US-018 database", () => {
  it("0009 truncates sub-millisecond answer and finish timestamps (deadline >= served still holds), then its CHECKs hold", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(8);
    try {
      await deployOld(name, folder, async (old) => {
        const [product] = await old<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook', 49000) RETURNING id`;
        const [program] = await old<{ id: string }[]>`
          INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
          VALUES (${product?.id ?? ""}, 'ms-upgrade', 'P', 'published', '2027-04-01', '2027-07-01', 30) RETURNING id`;
        const [set] = await old<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${program?.id ?? ""}, 1, 'S') RETURNING id`;
        const [question] = await old<{ id: string }[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${set?.id ?? ""}, 1, 'Q', 10, 20) RETURNING id`;
        const [player] = await old<{ id: string }[]>`INSERT INTO players (phone, name) VALUES ('+6281234567890', 'P') RETURNING id`;
        const [attempt] = await old<{ id: string }[]>`
          INSERT INTO set_attempts (player_id, set_id, finished_at) VALUES (${player?.id ?? ""}, ${set?.id ?? ""}, '2027-05-01 03:00:10.123999+00') RETURNING id`;
        // served and deadline inside the same millisecond, deadline later by microseconds.
        await old`
          INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at)
          VALUES (${attempt?.id ?? ""}, ${question?.id ?? ""}, 1, '{}', '2027-05-01 03:00:00.123456+00', '2027-05-01 03:00:00.123789+00', '2027-05-01 03:00:04.567891+00')`;
        await old`INSERT INTO player_program_stats (player_id, program_id, finished_at) VALUES (${player?.id ?? ""}, ${program?.id ?? ""}, '2027-05-01 03:00:10.123999+00')`;
      });

      await runMigrations(databaseUrl(name)); // applies 0009 and the sql/ files

      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        const [row] = await check<{ served: string; deadline: string; answered: string; ordered: boolean; attempt: string; stats: string }[]>`
          SELECT to_char(aq.served_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS served, to_char(aq.deadline_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS deadline,
                 to_char(aq.answered_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS answered, aq.deadline_at >= aq.served_at AS ordered,
                 to_char(a.finished_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS attempt, to_char(st.finished_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS stats
            FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id JOIN player_program_stats st ON st.player_id = a.player_id`;
        expect(row).toEqual({ served: "03:00:00.123000", deadline: "03:00:00.123000", answered: "03:00:04.567000", ordered: true, attempt: "03:00:10.123000", stats: "03:00:10.123000" });
        // From now on every writer must store whole milliseconds, within the new bounds.
        await expect(check`UPDATE attempt_questions SET answered_at = '2027-05-01 03:00:05.000001+00'`).rejects.toMatchObject({ code: "23514" });
        await expect(check`UPDATE set_attempts SET finished_at = '2027-05-01 03:00:05.000001+00'`).rejects.toMatchObject({ code: "23514" });
        await expect(check`UPDATE programs SET default_timer_seconds = 601`).rejects.toMatchObject({ code: "23514" });
        await expect(check`UPDATE app_settings SET value = '6' WHERE key = 'otp.max_attempts'`).rejects.toMatchObject({ code: "23514" });
        await runMigrations(databaseUrl(name)); // re-runnable
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

describe("upgrading a database from before the opener variety and the warm-up (0026)", () => {
  // The Owner-approved wordings, copied from the decision (independent of the migration and of seed.sql).
  const APPROVED: Readonly<Record<number, string>> = {
    4: "{sapaan} {nama}, ebook {judul_ebook} pesanan Anda sudah siap. Cukup balas pesan ini, nanti filenya kami kirim langsung di chat ini ya.",
    5: '[[Halo|Hai]] {nama}, pembayaran {judul_ebook} sudah masuk. Boleh balas "ok" supaya ebooknya kami kirim di sini?',
    6: "{sapaan} {nama}! Terima kasih atas pembelian {judul_ebook}. Balas chat ini kapan saja, ebooknya akan kami kirim ke nomor ini.",
    7: "Hai {nama}, pesanan {judul_ebook} Anda sudah lunas. Supaya ebooknya bisa kami kirim lewat WhatsApp, [[cukup|tinggal]] balas pesan ini ya.",
    8: "{sapaan} {nama}, kami mau kirim ebook {judul_ebook} yang Anda beli. Balas pesan ini dulu ya, setelah itu filenya langsung kami kirim.",
    9: "Halo {nama}, terima kasih sudah berbelanja. Ebook {judul_ebook} siap dikirim, [[balas|jawab]] pesan ini dengan kata apa saja ya.",
    10: "{sapaan} {nama}. Pembayaran untuk {judul_ebook} sudah kami terima, terima kasih! Silakan balas chat ini, ebooknya segera kami kirim.",
  };

  const wordings = (check: postgres.Sql) =>
    check<{ key: string; body: string }[]>`
      SELECT key, body FROM message_templates WHERE key LIKE 'delivery\_opener\_%' AND channel = 'whatsapp' AND locale = 'id' ORDER BY substring(key from '[0-9]+$')::int`;

  it("starts the warm-up of the numbers that exist, adds wordings 4 to 10 beside the Owner's own 1 to 3 without touching them, and never puts a removed one back", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(25);
    try {
      await deployOld(name, folder, async (old) => {
        const [server] = await old<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('S', 'https://waha.example.test/', 'waha.example.test') RETURNING id`;
        for (const session of ["one", "two"]) await old`INSERT INTO waha_sessions (server_id, session_name) VALUES (${server?.id ?? ""}, ${session})`;
        await old`
          INSERT INTO message_templates (key, channel, locale, body) VALUES
            ('delivery_opener_1', 'whatsapp', 'id', 'Halo {nama}, satu.'),
            ('delivery_opener_2', 'whatsapp', 'id', 'Edit sang Owner untuk {nama}.'),
            ('delivery_opener_3', 'whatsapp', 'id', 'Hai {nama}, tiga.')`;
      });

      await runMigrations(databaseUrl(name)); // applies 0026 and the sql/ files

      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        // The numbers that existed are NEW numbers (Owner): their warm-up starts at the upgrade.
        const sessions = await check<{ recent: boolean }[]>`SELECT warmup_started_at > now() - interval '5 minutes' AS recent FROM waha_sessions`;
        expect(sessions).toEqual([{ recent: true }, { recent: true }]);
        const rows = await wordings(check);
        expect(rows.map((r) => r.key)).toEqual(Array.from({ length: 10 }, (_, i) => `delivery_opener_${String(i + 1)}`));
        // 1 to 3 are untouched (an Owner's edit above all), 4 to 10 are the approved text.
        expect(rows.slice(0, 3).map((r) => r.body)).toEqual(["Halo {nama}, satu.", "Edit sang Owner untuk {nama}.", "Hai {nama}, tiga."]);
        for (const [n, body] of Object.entries(APPROVED)) expect(rows[Number(n) - 1]?.body, `wording ${n}`).toBe(body);
        // The new column exists, empty on what was there.
        expect(await check`SELECT variant_key FROM delivery_openers`).toHaveLength(0);

        // The Owner removes wording 5 and marks a number as established; a later deploy (the sql/ files run every time) puts neither back.
        await check`DELETE FROM message_templates WHERE key = 'delivery_opener_5'`;
        await check`UPDATE waha_sessions SET warmup_started_at = NULL WHERE session_name = 'one'`;
        await runMigrations(databaseUrl(name));
        expect((await wordings(check)).map((r) => r.key)).not.toContain("delivery_opener_5");
        expect(await check<{ session_name: string }[]>`SELECT session_name FROM waha_sessions WHERE warmup_started_at IS NULL`).toEqual([{ session_name: "one" }]);
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);

  it("a database that has no wording yet (a fresh install) is seeded with all ten, the approved text for 4 to 10", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(25);
    try {
      await deployOld(name, folder);
      await runMigrations(databaseUrl(name));
      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        const rows = await wordings(check);
        expect(rows.map((r) => r.key)).toEqual(Array.from({ length: 10 }, (_, i) => `delivery_opener_${String(i + 1)}`));
        for (const [n, body] of Object.entries(APPROVED)) expect(rows[Number(n) - 1]?.body, `wording ${n}`).toBe(body);
        // 1 to 3 are the original three.
        expect(rows[0]?.body).toBe("Halo {nama}, pembayaran Anda untuk {judul_ebook} sudah kami terima. Balas pesan ini ya, ebooknya langsung kami kirim ke sini.");
        expect(rows[1]?.body).toBe("Hai {nama}, terima kasih sudah membeli {judul_ebook}. Silakan balas pesan ini supaya ebooknya bisa kami kirim lewat WhatsApp.");
        expect(rows[2]?.body).toBe("Selamat datang {nama}! Pesanan {judul_ebook} sudah lunas. Balas pesan ini dengan satu kata saja, nanti ebooknya kami kirim di chat ini.");
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

describe("upgrading a pre-US-020-review database (security review P2-D)", () => {
  it("0012 gives every existing order a 32-byte buyer_key, then requires one, and stays re-runnable", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(11);
    try {
      await deployOld(name, folder, async (old) => {
        const [product] = await old<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('E', 49000) RETURNING id`;
        const [program] = await old<{ id: string }[]>`
          INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
          VALUES (${product?.id ?? ""}, 'buyer-key', 'P', 'published', '2027-04-01', '2027-07-01', 30) RETURNING id`;
        const [lp] = await old<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_bk${randomBytes(6).toString("hex")}`}, 'LP', ${program?.id ?? ""}) RETURNING id`;
        for (const status of ["pending", "paid"]) {
          await old`
            INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, amount_idr, expires_at, status)
            VALUES (${randomBytes(10).toString("hex")}, ${randomBytes(5).toString("hex").toUpperCase()}, ${lp?.id ?? ""}, ${program?.id ?? ""}, ${product?.id ?? ""},
                    'B', '+6281234567890', 'b@example.invalid', 49000, now() + interval '1 day', ${status})`;
        }
      });

      await runMigrations(databaseUrl(name)); // applies 0012 and the sql/ files

      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        const rows = await check<{ id: string; length: number; key: string }[]>`SELECT id, octet_length(buyer_key) AS length, encode(buyer_key, 'hex') AS key FROM orders ORDER BY id`;
        expect(rows).toHaveLength(2);
        for (const row of rows) expect(row.length).toBe(32);
        // A key no checkout can produce: a hash of the order's own id.
        expect(new Set(rows.map((r) => r.key)).size).toBe(2);
        const [nullable] = await check<{ is_nullable: string }[]>`
          SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'buyer_key'`;
        expect(nullable?.is_nullable).toBe("NO");
        await expect(check`UPDATE orders SET buyer_key = NULL`).rejects.toMatchObject({ code: "23502" });
        await expect(check`UPDATE orders SET buyer_key = decode('00', 'hex')`).rejects.toMatchObject({ code: "23514" });
        await runMigrations(databaseUrl(name)); // re-runnable
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
