import { describe, expect, it } from "vitest";
import { blankCommentsAndStrings, checkMigration, checkRange } from "./expand-only.ts";

const rules = (sql: string): string[] => checkMigration(sql).findings.map((f) => f.rule);

describe("expand-only migrations (the rule of a rolling deploy, US-015)", () => {
  it("accepts what only adds: tables, nullable and defaulted columns, indexes, functions", () => {
    const sql = [
      'CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "name" text NOT NULL);',
      "--> statement-breakpoint",
      'ALTER TABLE "orders" ADD COLUMN "note" text;',
      "--> statement-breakpoint",
      'ALTER TABLE "orders" ADD COLUMN "tier" integer NOT NULL DEFAULT 0, ADD COLUMN "tag" text;',
      'CREATE INDEX "orders_tier_idx" ON "orders" ("tier");',
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_tier_check" CHECK ("tier" >= 0);',
    ].join("\n");
    expect(checkMigration(sql)).toEqual({ findings: [], marked: false, ok: true });
  });

  it.each([
    ["drop table", 'DROP TABLE "legacy";'],
    ["drop column", 'ALTER TABLE "orders" DROP COLUMN "old";'],
    ["drop schema or type", "DROP TYPE order_state;"],
    ["rename", 'ALTER TABLE "orders" RENAME COLUMN "a" TO "b";'],
    ["rename", 'ALTER TABLE "orders" RENAME TO "purchases";'],
    ["change a column's type", 'ALTER TABLE "orders" ALTER COLUMN "amount" TYPE bigint;'],
    ["change a column's type", 'ALTER TABLE "orders" ALTER COLUMN "amount" SET DATA TYPE bigint;'],
    ["make an existing column NOT NULL", 'ALTER TABLE "orders" ALTER COLUMN "note" SET NOT NULL;'],
    ["add a NOT NULL column without a default", 'ALTER TABLE "orders" ADD COLUMN "tier" integer NOT NULL;'],
    ["truncate", 'TRUNCATE "audit_staging";'],
  ])("refuses %s", (rule, sql) => {
    expect(rules(sql)).toContain(rule);
    expect(checkMigration(sql).ok).toBe(false);
  });

  it("refuses a NOT NULL column without a default even beside one that has it, and reports the line", () => {
    const sql = ['ALTER TABLE "t"', '  ADD COLUMN "a" integer NOT NULL DEFAULT 1,', '  ADD COLUMN "b" integer NOT NULL;'].join("\n");
    const check = checkMigration(sql);
    expect(check.findings.map((f) => [f.line, f.rule])).toEqual([[1, "add a NOT NULL column without a default"]]);
  });

  it("is case-insensitive and sees every statement of a file, with its line", () => {
    const sql = 'create table "a" ("id" int);\n\nalter table "b" drop column "c";\nalter table "d" rename to "e";';
    expect(checkMigration(sql).findings.map((f) => [f.line, f.rule])).toEqual([
      [3, "drop column"],
      [4, "rename"],
    ]);
  });

  it("ignores comments and string literals: a word in prose or in data is not a statement", () => {
    const sql = [
      "-- a later release will DROP TABLE legacy",
      "/* RENAME COLUMN is for the contract step */",
      "INSERT INTO app_settings (key, value) VALUES ('note', '\"DROP COLUMN; TRUNCATE\"');",
      "INSERT INTO app_settings (key, value) VALUES ('it''s', '1');",
    ].join("\n");
    expect(checkMigration(sql).findings).toEqual([]);
    expect(blankCommentsAndStrings("a 'b;c' -- d\ne")).toBe("a '   '     \ne");
  });

  it("accepts a contract step that says why on a line of its own, and only then", () => {
    const sql = '-- contract-ok: nothing deployed since release 14 reads legacy_code\nALTER TABLE "orders" DROP COLUMN "legacy_code";';
    expect(checkMigration(sql)).toMatchObject({ marked: true, ok: true });
    expect(checkMigration(sql).findings).toHaveLength(1);
    // No reason, a reason that is not one, or the marker inside a statement: not a marker.
    expect(checkMigration('-- contract-ok:\nDROP TABLE "x";').ok).toBe(false);
    expect(checkMigration('-- contract-ok: ok\nDROP TABLE "x";').ok).toBe(false);
    expect(checkMigration('DROP TABLE "x"; -- contract-ok: the old release is gone').ok).toBe(false);
  });

  it.each([
    ["DROP FUNCTION", 'DROP FUNCTION IF EXISTS "public"."claim_job"(uuid);', "drop a function, view, trigger, policy or sequence"],
    ["DROP VIEW", 'DROP VIEW "v_orders";', "drop a function, view, trigger, policy or sequence"],
    ["DROP MATERIALIZED VIEW", "DROP MATERIALIZED VIEW m;", "drop a function, view, trigger, policy or sequence"],
    ["DROP TRIGGER", 'DROP TRIGGER audit ON "orders";', "drop a function, view, trigger, policy or sequence"],
    ["DROP POLICY", 'DROP POLICY p ON "orders";', "drop a function, view, trigger, policy or sequence"],
    ["DROP SEQUENCE", "drop sequence order_seq;", "drop a function, view, trigger, policy or sequence"],
    ["DROP DEFAULT", 'ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;', "drop a column's default"],
    ["REVOKE", "REVOKE SELECT ON public.alert_recipients FROM worker_rw;", "revoke a privilege"],
    ["a signature change by drop and create", 'DROP FUNCTION f(int);\nCREATE FUNCTION f(int, int) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;', "drop a function, view, trigger, policy or sequence"],
  ])("refuses %s", (_name, sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it("accepts what relaxes or adds: DROP NOT NULL, GRANT, CREATE OR REPLACE, a new default", () => {
    const sql = [
      'ALTER TABLE "orders" ALTER COLUMN "note" DROP NOT NULL;',
      "GRANT SELECT ON public.alert_recipients TO worker_rw;",
      "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;",
      "ALTER TABLE \"orders\" ALTER COLUMN \"status\" SET DEFAULT 'new';",
      "-- a REVOKE or DROP TRIGGER in a comment does not count",
    ].join("\n");
    expect(checkMigration(sql).findings).toEqual([]);
  });
});

describe("the range of a deploy (every migration since the release on the VM, possibly many commits)", () => {
  const clean = { name: "0030_add.sql", sql: 'ALTER TABLE "orders" ADD COLUMN "note" text;' };
  const unmarked = { name: "0031_drop.sql", sql: 'ALTER TABLE "orders" DROP COLUMN "legacy";' };
  const marked = { name: "0032_contract.sql", sql: '-- contract-ok: nothing since release 14 reads legacy_code\nALTER TABLE "orders" DROP COLUMN "legacy_code";' };

  it("accepts a range that only expands", () => {
    expect(checkRange([clean], { strict: true })).toMatchObject({ ok: true, unmarked: [], markedRefused: [] });
    expect(checkRange([], { strict: true }).ok).toBe(true);
  });

  it("refuses an unmarked contract step in any mode, even with the allowance", () => {
    expect(checkRange([clean, unmarked], { strict: false })).toMatchObject({ ok: false, unmarked: ["0031_drop.sql"] });
    expect(checkRange([clean, unmarked], { strict: true, allowContractOk: true })).toMatchObject({ ok: false, unmarked: ["0031_drop.sql"] });
  });

  it("outside a deploy (CI on a change) a contract-ok line covers its file", () => {
    expect(checkRange([clean, marked], { strict: false })).toMatchObject({ ok: true, markedAccepted: ["0032_contract.sql"], markedRefused: [] });
  });

  it("in a deploy range a contract-ok line does not: the release on the VM may still use what it removes", () => {
    expect(checkRange([clean, marked], { strict: true })).toMatchObject({ ok: false, markedRefused: ["0032_contract.sql"], markedAccepted: [] });
  });

  it("...unless the operator allows it on purpose (the workflow input allow_contract_ok)", () => {
    expect(checkRange([clean, marked], { strict: true, allowContractOk: true })).toMatchObject({ ok: true, markedAccepted: ["0032_contract.sql"] });
  });

  it("a contract-ok line on a file with nothing to contract changes nothing", () => {
    const harmless = { name: "0033.sql", sql: '-- contract-ok: nothing here contracts anything at all\nCREATE TABLE "t" ("id" uuid);' };
    expect(checkRange([harmless], { strict: true })).toMatchObject({ ok: true, markedRefused: [], markedAccepted: [] });
  });
});
