// Criterion 1: the schema covers plan M2.1, IDR is bigint, timestamps are timestamptz, and the
// migrations applied cleanly (twice) to the empty database created by global-setup.ts.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asRole, sql, sqlState } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

const PLAN_TABLES = {
  public: [
    // catalog
    "products",
    "programs",
    "trivia_sets",
    "questions",
    "question_options",
    // player
    "players",
    "player_programs",
    "player_otps",
    "otp_enqueues",
    "magic_links",
    // play
    "set_attempts",
    "attempt_questions",
    "deadline_extensions", // US-028: the Owner's outage extensions, one per answer
    "player_program_stats",
    "leaderboard_snapshots",
    "prize_tiers",
    "winners",
    "fulfillments",
    // funnel
    "landing_pages",
    "landing_page_adnets",
    "lp_domains",
    "lp_versions",
    "visits",
    "orders",
    "midtrans_attempts",
    "payment_notifications",
    "payments",
    // tracking
    "adnets",
    "conversion_events",
    "conversion_attempts",
    // delivery
    "deliveries",
    "waha_servers",
    "waha_sessions",
    "waha_inbound",
    // infra & governance
    "outbox",
    "admin_profiles",
    "audit_log",
    "ad_spend",
    "message_templates",
    "legal_pages",
    "consents",
    "deletion_requests",
    "settings_secrets",
    "app_settings",
    "uploads",
    "alerts",
    "heartbeats",
    // admin settings (US-017)
    "smtp_settings",
    "template_test_sends",
    "upload_sessions",
    "test_recipients",
    // payment reconciliation (US-021)
    "payment_reconciliation_runs",
    "payment_reconciliation_findings",
  ],
  player_auth: ["account", "session", "user", "verification"],
  admin_auth: ["account", "login_throttle", "recovery_code", "session", "session_state", "totp_used", "twoFactor", "user", "verification"],
} as const;

describe("migrations", () => {
  it("recorded every drizzle migration file in the journal", async () => {
    const files = (await readdir(join(import.meta.dirname, "..", "migrations"))).filter((f) => f.endsWith(".sql"));
    const [row] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`;
    expect(Number(row?.n)).toBe(files.length);
    expect(files.length).toBeGreaterThan(0);
  });

  it("runs on PostgreSQL 18", async () => {
    const [row] = await sql<{ v: string }[]>`SELECT current_setting('server_version_num') AS v`;
    expect(Number(row?.v)).toBeGreaterThanOrEqual(180000);
  });
});

describe("schema coverage (plan M2.1)", () => {
  it.each(Object.entries(PLAN_TABLES))("schema %s has exactly the planned tables", async (schema, tables) => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([...tables].sort());
  });

  it("has no table in an unexpected schema", async () => {
    const rows = await sql<{ table_schema: string }[]>`
      SELECT DISTINCT table_schema FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`;
    expect(rows.map((r) => r.table_schema)).toEqual(["admin_auth", "drizzle", "player_auth", "public"]);
  });
});

describe("column types", () => {
  it("has no timestamp/time column without time zone", async () => {
    const rows = await sql`
      SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND data_type IN ('timestamp without time zone', 'time without time zone')`;
    expect(rows).toEqual([]);
    const [tz] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema IN ('public', 'player_auth', 'admin_auth') AND data_type = 'timestamp with time zone'`;
    expect(Number(tz?.n)).toBeGreaterThan(50);
  });

  it("stores every IDR amount as bigint with a CHECK constraint", async () => {
    const rows = await sql<{ col: string; data_type: string; checked: boolean }[]>`
      SELECT c.table_name || '.' || c.column_name AS col, c.data_type,
             EXISTS (
               SELECT 1 FROM pg_constraint k
               JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
               WHERE k.contype = 'c' AND k.conrelid = ('public.' || quote_ident(c.table_name))::regclass
                 AND a.attname = c.column_name
             ) AS checked
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_idr'
      ORDER BY 1`;
    expect(rows.map((r) => r.col)).toEqual(
      expect.arrayContaining([
        "ad_spend.amount_idr",
        "adnets.payout_idr",
        "conversion_events.value_idr",
        "orders.amount_idr",
        "payments.fee_idr",
        "payments.gross_amount_idr",
        "prize_tiers.value_idr",
        "products.price_idr",
      ]),
    );
    for (const r of rows) {
      expect({ col: r.col, type: r.data_type, checked: r.checked }).toEqual({ col: r.col, type: "bigint", checked: true });
    }
  });

  it("has no numeric, money or floating point column (no fractional rupiah)", async () => {
    const rows = await sql`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('numeric', 'money', 'real', 'double precision')`;
    expect(rows).toEqual([]);
  });

  it("models the plan's state lists exactly", async () => {
    const enums = await sql<{ name: string; labels: string[] }[]>`
      SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('order_status', 'delivery_status', 'conversion_status')
      GROUP BY t.typname ORDER BY t.typname`;
    expect(enums).toEqual([
      { name: "conversion_status", labels: ["pending", "sending", "sent", "failed"] },
      { name: "delivery_status", labels: ["pending", "sending", "sent", "failed", "unknown", "cancelled"] },
      {
        name: "order_status",
        labels: ["pending", "paid", "review", "expired", "gateway_failed", "snap_create_failed", "refunded"],
      },
    ]);
  });
});

describe("constraints named by the plan", () => {
  it.each([
    ["set_attempts", "UNIQUE (player_id, set_id)"],
    ["midtrans_attempts", "UNIQUE (midtrans_order_id)"],
    ["payment_notifications", "UNIQUE (midtrans_order_id, transaction_status, status_code, signature)"],
    ["conversion_events", "UNIQUE (order_id, sink, kind)"],
    ["waha_inbound", "UNIQUE (message_id)"],
    ["deliveries", "UNIQUE (order_id, channel)"],
    ["orders", "UNIQUE (order_code)"],
    ["orders", "UNIQUE (public_id)"],
    ["outbox", "UNIQUE (dedupe_key)"],
  ])("%s has %s", async (table, def) => {
    const rows = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ${`public.${table}`}::regclass AND contype = 'u'`;
    expect(rows.map((r) => r.def)).toContain(def);
  });

  it("indexes player_programs.eligible", async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'player_programs'`;
    expect(rows.some((r) => /\(program_id, eligible\)/.test(r.indexdef))).toBe(true);
  });

  it("enforces the order_code format (Crockford base32, >= 8 chars = 40 bits)", async () => {
    const { productId, programId } = await createProgram();
    const landingPageId = await createLandingPage(programId);
    const base = { landingPageId, programId, productId };
    const insert = (code: string) =>
      asRole("public_rw", (tx) => tx`INSERT INTO orders ${tx({ ...orderRow(base), order_code: code })}`);
    await insert("7ZK4M2QH9R");
    for (const bad of ["7ZK4M2Q", "7ZK4M2QHIR", "7zk4m2qh9r", "7ZK4M2QHUR", "7ZK4M2QHLR", "7ZK4M2QHOR"]) {
      expect(await sqlState(insert(bad))).toBe("23514");
    }
  });
});

describe("adnets.clickid_param (US-019)", () => {
  const insert = (param: string) => sql`INSERT INTO adnets (slug, name, clickid_param) VALUES (${`a-${Math.random().toString(36).slice(2, 10)}`}, 'Adnet', ${param})`;

  it("accepts an ordinary click-id parameter name", async () => {
    for (const ok of ["cid", "clickid", "aff_click_id", "transaction_id", "sub.id-1", "swap_id", "shpclid", "ad_wave", "gwa", "hpid", "oauth", "username"]) {
      await insert(ok);
    }
  });

  it("refuses a name that has a personal-data word as a whole word, in any case: the SDK sends whatever the parameter carries", async () => {
    for (const bad of ["email", "EMAIL", "e-mail", "phone", "phone_number", "no_hp", "no_wa", "whatsapp", "nama_lengkap", "access_token", "otp", "kode_otp", "nik", "ktp", "card_number", "kartu", "password", "pwd", "secret", "client_secret", "session_id", "nomor.hp", "user-password"]) {
      expect(await sqlState(insert(bad)), bad).toBe("23514");
    }
  });

  it("still refuses a name outside the plain format", async () => {
    for (const bad of ["", "a b", "a".repeat(65), "a/b"]) expect(await sqlState(insert(bad)), bad).toBe("23514");
  });
});
