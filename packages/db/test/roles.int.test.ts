// Criteria 2 and 4: roles, SECURITY DEFINER hygiene, the privilege matrix and the denial tests.
// Every denial asserts the exact SQLSTATE (42501 insufficient_privilege, or the ET0xx codes).
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { runMigrations } from "../src/migrate.ts";
import { APP_ROLES, asRole, bytes, first, rolledBack, sql, sqlState, type Tx } from "./db.ts";
import { createAttempt, createLandingPage, createPlayer, createProgram, createTriviaSet, orderRow } from "./fixtures.ts";

const GROUP_ROLES = ["admin_rw", "internal_rw", "migrator", "public_rw", "worker_rw"];
/** The one object not owned by migrator (US-018): the Owner's scoring override, owned by trivia_override. */
const OVERRIDE_FUNCTION = "public.override_question_scoring(p_program_id uuid, p_set_id uuid, p_question_id uuid, p_points integer, p_timer_seconds integer, p_correct_option_id uuid, p_reason text, p_actor_admin_user_id text, p_request_id text, p_ip inet)";
/** US-028: the contest's functions (sql/contest.sql), owned by contest_results. */
const CONTEST_FUNCTIONS = [
  "public.confirm_program_winners(p_program_id uuid, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
  "public.create_leaderboard_snapshot(p_program_id uuid)",
  "public.extend_open_question_deadlines(p_program_id uuid, p_outage_started_at timestamp with time zone, p_outage_ended_at timestamp with time zone, p_reason text, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
  "public.program_winners_banner(p_program_id uuid)",
];
/** US-024: the Owner's conversion re-fire (sql/conversions.sql), owned by conversion_refire. */
const REFIRE_FUNCTION = "public.refire_conversion(p_id uuid, p_resend_sent boolean DEFAULT false)";
/** US-025 / US-029: the explicit resend of a delivery (sql/delivery-resend.sql), owned by delivery_resend. */
const RESEND_FUNCTION = "public.resend_delivery(p_id uuid, p_confirm_unknown boolean DEFAULT false)";
/** US-027: the play entry points of the public app (sql/play.sql), owned by trivia_play. */
const PLAY_FUNCTIONS = [
  "public.play_answer(p_player_id uuid, p_answer_id uuid, p_option_id uuid, p_ip inet, p_ua_hash bytea)",
  "public.play_attempts(p_player_id uuid, p_program_id uuid)",
  "public.play_current(p_player_id uuid, p_attempt_id uuid, p_ip inet, p_ua_hash bytea)",
  "public.play_leaderboard(p_program_id uuid, p_limit integer)",
  "public.play_note_unlocked(p_player_id uuid, p_program_id uuid)",
  "public.play_reveal(p_player_id uuid, p_answer_id uuid)",
  "public.play_settle(p_player_id uuid, p_answer_id uuid)",
  "public.play_standing(p_player_id uuid, p_program_id uuid)",
  "public.play_start_set(p_player_id uuid, p_set_id uuid)",
];
/** US-030: the prize fulfilment functions (sql/fulfillment.sql), owned by prize_fulfillment. */
const FULFILLMENT_FUNCTIONS = [
  "public.fulfillment_set_notes(p_fulfillment_id uuid, p_notes text, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
  "public.fulfillment_set_proof(p_fulfillment_id uuid, p_upload_id uuid, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
  "public.fulfillment_step(p_fulfillment_id uuid, p_from text, p_to text, p_reason text, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
];
/** US-030: the Owner's revoke and re-award, and reinstatement (sql/contest.sql), owned by contest_results. */
const REAWARD_FUNCTIONS = [
  "public.reinstate_winner(p_winner_id uuid, p_reason text, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
  "public.revoke_winner(p_winner_id uuid, p_reason text, p_actor_admin_user_id text, p_request_id text, p_ip inet)",
];
/** US-030: the erasure of a data subject (sql/privacy.sql), owned by pii_eraser. */
const ERASE_FUNCTION = "public.erase_data_subject(p_request_id uuid, p_confirmation text, p_actor_admin_user_id text, p_request text, p_ip inet)";
/** US-033: the Owner's decision on an order in review (sql/order-review.sql), owned by order_review. */
const REVIEW_FUNCTION =
  "public.order_review_decide(p_order_id uuid, p_decision text, p_confirm text, p_reason text, p_request_key uuid, p_actor_admin_user_id text, p_request_id text, p_ip inet)";
const ownerOf = (sig: string): string =>
  FULFILLMENT_FUNCTIONS.includes(sig)
    ? "prize_fulfillment"
    : REAWARD_FUNCTIONS.includes(sig)
      ? "contest_results"
      : sig === ERASE_FUNCTION
        ? "pii_eraser"
        : sig === OVERRIDE_FUNCTION
    ? "trivia_override"
    : CONTEST_FUNCTIONS.includes(sig)
      ? "contest_results"
      : sig === REFIRE_FUNCTION
        ? "conversion_refire"
        : sig === RESEND_FUNCTION
          ? "delivery_resend"
          : PLAY_FUNCTIONS.includes(sig)
            ? "trivia_play"
            : sig === REVIEW_FUNCTION
              ? "order_review"
              : "migrator";
const DEFINER_FUNCTIONS = [
  "public.enqueue_mo(p_order_id uuid)",
  "public.enqueue_notification(p_inbox_id uuid)",
  "public.enqueue_otp(p_otp_id uuid)",
  "public.enqueue_waha_inbound(p_inbound_id uuid)",
  "public.get_payment_secret()",
  "public.record_waha_ack(p_message_id text, p_ack text)",
];

/** Every privilege held by anyone but the owner, one line each, sorted. */
async function privilegeMatrix(): Promise<string[]> {
  const rows = await sql<{ line: string }[]>`
    WITH rel AS (
      SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relacl, c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    ), lines AS (
      SELECT a.grantee, a.privilege_type || ' ' || rel.name AS what
      FROM rel CROSS JOIN LATERAL aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) a
      UNION ALL
      SELECT a.grantee, a.privilege_type || ' ' || rel.name || '(' || att.attname || ')'
      FROM rel JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      UNION ALL
      SELECT a.grantee, 'EXECUTE ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle')
      UNION ALL
      SELECT a.grantee, a.privilege_type || ' SCHEMA ' || n.nspname
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle')
      UNION ALL
      SELECT a.grantee, a.privilege_type || ' DATABASE'
      FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      WHERE d.datname = current_database()
    )
    SELECT coalesce(r.rolname, 'PUBLIC') || ' ' || lines.what AS line
    FROM lines LEFT JOIN pg_roles r ON r.oid = lines.grantee
    WHERE coalesce(r.rolname, 'PUBLIC') <> 'migrator'
      -- the database owner is whichever superuser TEST_PG_URL uses; not part of the contract
      AND lines.grantee <> (SELECT datdba FROM pg_database WHERE datname = current_database())
    ORDER BY 1`;
  return rows.map((r) => r.line);
}

/** Per-role settings of the group roles (any database) and the database default search_path. */
async function roleSettings(): Promise<string[]> {
  const rows = await sql<{ line: string }[]>`
    SELECT coalesce(r.rolname, '(database)') || ' ' || array_to_string(s.setconfig, ';') AS line
    FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole
    WHERE r.rolname = ANY (${GROUP_ROLES})
       OR (s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
    ORDER BY 1`;
  return rows.map((r) => r.line);
}

/** Parameter privileges (GRANT SET/ALTER SYSTEM ON PARAMETER) held by the group roles. */
async function groupParameterPrivileges(): Promise<string[]> {
  const rows = await sql<{ line: string }[]>`
    SELECT r.rolname || ' ' || a.privilege_type || ' ' || p.parname AS line
    FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = ANY (${GROUP_ROLES}) ORDER BY 1`;
  return rows.map((r) => r.line);
}

/** A throwaway LOGIN role that is a member of `memberOf`; dropped afterwards (roles are cluster-global). */
async function withLoginRole<T>(memberOf: string[], fn: (url: string) => Promise<T>): Promise<T> {
  const name = `ebt_probe_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  await sql.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  try {
    for (const group of memberOf) await sql.unsafe(`GRANT ${group} TO ${name}`);
    const url = new URL(inject("dbUrl"));
    url.username = name;
    url.password = password;
    return await fn(url.toString());
  } finally {
    await sql.unsafe(`DROP ROLE IF EXISTS ${name}`);
  }
}

const migrationError = (): Promise<unknown> => runMigrations(inject("dbUrl")).then(() => undefined, (e: unknown) => e);

/** Every role the five group roles are members of (must be none: members are login users). */
async function groupMemberships(): Promise<string[]> {
  const rows = await sql<{ line: string }[]>`
    SELECT m.rolname || ' MEMBER OF ' || g.rolname AS line
    FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
    WHERE m.rolname = ANY (${GROUP_ROLES}) ORDER BY 1`;
  return rows.map((r) => r.line);
}

/**
 * Column lists of every table public_rw or internal_rw can reach through a TABLE-level grant:
 * a column added later is readable/writable at once, so it must show up in review.
 */
async function tableLevelGrantColumns(db: Pick<Tx, "unsafe"> = sql): Promise<string[]> {
  const rows = await db.unsafe<{ line: string }[]>(`
    SELECT r.rolname || ' ' || a.privilege_type || ' ' || n.nspname || '.' || c.relname || ': '
           || (SELECT string_agg(att.attname, ', ' ORDER BY att.attnum) FROM pg_attribute att
               WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped) AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname IN ('public', 'player_auth', 'admin_auth') AND c.relkind = 'r'
      AND r.rolname IN ('public_rw', 'internal_rw')
    ORDER BY 1`);
  return rows.map((r) => r.line);
}

describe("group roles (roles.sql)", () => {
  it("creates the five roles as NOLOGIN with no elevated attributes", async () => {
    const rows = await sql`
      SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = ANY (${GROUP_ROLES}) ORDER BY rolname`;
    expect(rows).toEqual(
      GROUP_ROLES.map((rolname) => ({
        rolname,
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      })),
    );
  });

  it("makes the group roles members of no role at all (not each other, not pg_* roles)", async () => {
    expect(await groupMemberships()).toEqual([]);
  });

  it.each(["trivia_override", "contest_results", "conversion_refire", "delivery_resend", "trivia_play", "prize_fulfillment", "pii_eraser", "order_review"])("creates %s NOLOGIN, with no members and a member of nothing (US-018, US-028, US-024, US-025, US-027, US-030, US-033)", async (name) => {
    const [role] = await sql`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
             (SELECT count(*)::int FROM pg_auth_members am WHERE am.roleid = r.oid OR am.member = r.oid) AS memberships
      FROM pg_roles r WHERE rolname = ${name}`;
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, memberships: 0 });
  });

  it.each(["trivia_override", "contest_results", "conversion_refire", "delivery_resend", "trivia_play", "prize_fulfillment", "pii_eraser", "order_review"])("removes any membership in %s on a re-run (a member could SET ROLE to it)", async (name) => {
    await sql.unsafe(`GRANT ${name} TO admin_rw`);
    try {
      await runMigrations(inject("dbUrl"));
      const rows = await sql`SELECT 1 FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid WHERE g.rolname = ${name}`;
      expect(rows).toEqual([]);
    } finally {
      await sql.unsafe(`REVOKE ${name} FROM admin_rw`).catch(() => undefined);
    }
  });

  it("makes migrator the owner of every object but the override function (trivia_override), the contest functions (contest_results), the conversion re-fire (conversion_refire) and the play functions (trivia_play)", async () => {
    const rows = await sql`
      SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND pg_get_userbyid(c.relowner) <> 'migrator'
      UNION ALL
      SELECT n.nspname, p.proname, pg_get_userbyid(p.proowner)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND pg_get_userbyid(p.proowner) <> 'migrator'
      UNION ALL
      SELECT nspname, '(schema)', pg_get_userbyid(nspowner) FROM pg_namespace
      WHERE nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND pg_get_userbyid(nspowner) <> 'migrator'`;
    expect(rows).toEqual(
      expect.arrayContaining([
        { nspname: "public", relname: "override_question_scoring", owner: "trivia_override" },
        { nspname: "public", relname: "confirm_program_winners", owner: "contest_results" },
        { nspname: "public", relname: "create_leaderboard_snapshot", owner: "contest_results" },
        { nspname: "public", relname: "extend_open_question_deadlines", owner: "contest_results" },
        { nspname: "public", relname: "program_winners_banner", owner: "contest_results" },
        { nspname: "public", relname: "refire_conversion", owner: "conversion_refire" },
        { nspname: "public", relname: "resend_delivery", owner: "delivery_resend" },
        { nspname: "public", relname: "order_review_decide", owner: "order_review" },
        ...["play_answer", "play_attempts", "play_current", "play_leaderboard", "play_note_unlocked", "play_program_ms", "play_ranking", "play_reveal", "play_settle", "play_settle_answer", "play_settle_pending", "play_standing", "play_start_set", "play_unlocked_count"].map(
          (relname) => ({ nspname: "public", relname, owner: "trivia_play" }),
        ),
        ...["fulfillment_step", "fulfillment_set_notes", "fulfillment_set_proof"].map((relname) => ({ nspname: "public", relname, owner: "prize_fulfillment" })),
        { nspname: "public", relname: "revoke_winner", owner: "contest_results" },
        { nspname: "public", relname: "reinstate_winner", owner: "contest_results" },
        { nspname: "public", relname: "erase_data_subject", owner: "pii_eraser" },
      ]),
    );
    expect(rows).toHaveLength(28);
  });
});

describe("SECURITY DEFINER functions (functions.sql, triggers.sql)", () => {
  async function functions() {
    return sql<{ sig: string; definer: boolean; config: string[] | null; owner: string; public_exec: boolean }[]>`
      SELECT 'public.' || p.proname || '(' || pg_get_function_arguments(p.oid) || ')' AS sig,
             p.prosecdef AS definer, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`;
  }

  it("includes the five required entry points", async () => {
    const definers = (await functions()).filter((f) => f.definer).map((f) => f.sig);
    expect(definers).toEqual(expect.arrayContaining(DEFINER_FUNCTIONS));
  });

  // Security review item 3: `public` on the search_path let a planted, better-matching function
  // win an unqualified call (see otp.int.test.ts). Every function now pins pg_catalog, pg_temp
  // (pg_temp last; it is never searched for functions or operators).
  it("pins search_path = pg_catalog, pg_temp, is owned by migrator (the override: trivia_override; the contest: contest_results; the re-fire: conversion_refire) and is not executable by PUBLIC", async () => {
    for (const f of (await functions()).filter((fn) => fn.definer)) {
      expect({ sig: f.sig, config: f.config, owner: f.owner, publicExecute: f.public_exec }).toEqual({
        sig: f.sig,
        config: ["search_path=pg_catalog, pg_temp"],
        owner: ownerOf(f.sig),
        publicExecute: false,
      });
    }
    expect((await functions()).filter((fn) => fn.definer).map((fn) => fn.sig)).toEqual(
      expect.arrayContaining([OVERRIDE_FUNCTION, ...CONTEST_FUNCTIONS, REFIRE_FUNCTION, ...PLAY_FUNCTIONS, ...FULFILLMENT_FUNCTIONS, ...REAWARD_FUNCTIONS, ERASE_FUNCTION, REVIEW_FUNCTION]),
    );
  });

  it("pins search_path = pg_catalog, pg_temp on every other function in public too", async () => {
    const wrong = (await functions()).filter((f) => f.config?.join() !== "search_path=pg_catalog, pg_temp");
    expect(wrong.map((f) => f.sig)).toEqual([]);
  });

  it("leaves no function in public executable by PUBLIC", async () => {
    expect((await functions()).filter((f) => f.public_exec).map((f) => f.sig)).toEqual([]);
  });

  it("grants EXECUTE per role exactly", async () => {
    const rows = await sql<{ fn: string; role: string; ok: boolean }[]>`
      SELECT fn, r AS role, has_function_privilege(r, fn, 'EXECUTE') AS ok
      FROM unnest(${[
        "public.enqueue_otp(uuid)",
        "public.enqueue_notification(uuid)",
        "public.enqueue_waha_inbound(uuid)",
        "public.enqueue_mo(uuid)",
        "public.enqueue_magic_link_resend(text)",
        "public.get_payment_secret()",
        "public.get_order_status(text)",
        "public.claim_browser_mt(text)",
        "public.sweep_login_throttle(integer)",
        "public.assert_trivia_set_unlocked(uuid)",
        "public.lock_program_contest(uuid)",
        "public.lock_program_contest_shared(uuid)",
        "public.override_question_scoring(uuid, uuid, uuid, integer, integer, uuid, text, text, text, inet)",
        "public.score_answer(integer, integer, uuid, uuid, timestamptz, timestamptz, timestamptz, integer)",
        "public.mask_name(text)",
        "public.mask_phone(text)",
        "public.create_leaderboard_snapshot(uuid)",
        "public.confirm_program_winners(uuid, text, text, inet)",
        "public.extend_open_question_deadlines(uuid, timestamptz, timestamptz, text, text, text, inet)",
        "public.program_winners_banner(uuid)",
        "public.record_waha_ack(text, text)",
        "public.play_unlocked_count(timestamptz, integer, integer, timestamptz, timestamptz, integer, integer)",
        "public.play_ranking(uuid)",
        "public.play_settle_answer(uuid)",
        "public.play_settle_pending(uuid)",
        "public.play_settle(uuid, uuid)",
        "public.play_program_ms(uuid)",
        "public.play_reveal(uuid, uuid)",
        "public.play_attempts(uuid, uuid)",
        "public.play_note_unlocked(uuid, uuid)",
        "public.play_start_set(uuid, uuid)",
        "public.play_current(uuid, uuid, inet, bytea)",
        "public.play_answer(uuid, uuid, uuid, inet, bytea)",
        "public.play_leaderboard(uuid, integer)",
        "public.play_standing(uuid, uuid)",
        "public.fulfillment_step(uuid, text, text, text, text, text, inet)",
        "public.fulfillment_set_notes(uuid, text, text, text, inet)",
        "public.fulfillment_set_proof(uuid, uuid, text, text, inet)",
        "public.revoke_winner(uuid, text, text, text, inet)",
        "public.reinstate_winner(uuid, text, text, text, inet)",
        "public.erase_data_subject(uuid, text, text, text, inet)",
        "public.prune_stranger_wa_contacts()",
      ]}::text[]) fn
      CROSS JOIN unnest(${[...APP_ROLES]}::text[]) r
      WHERE has_function_privilege(r, fn, 'EXECUTE') ORDER BY 1, 2`;
    expect(rows.map((r) => `${r.role} ${r.fn}`)).toEqual([
      "admin_rw public.assert_trivia_set_unlocked(uuid)",
      "public_rw public.claim_browser_mt(text)",
      "admin_rw public.confirm_program_winners(uuid, text, text, inet)",
      "worker_rw public.create_leaderboard_snapshot(uuid)",
      "public_rw public.enqueue_magic_link_resend(text)",
      "public_rw public.enqueue_mo(uuid)",
      "public_rw public.enqueue_notification(uuid)",
      "public_rw public.enqueue_otp(uuid)",
      "public_rw public.enqueue_waha_inbound(uuid)",
      "admin_rw public.erase_data_subject(uuid, text, text, text, inet)",
      "admin_rw public.extend_open_question_deadlines(uuid, timestamptz, timestamptz, text, text, text, inet)",
      "admin_rw public.fulfillment_set_notes(uuid, text, text, text, inet)",
      "admin_rw public.fulfillment_set_proof(uuid, uuid, text, text, inet)",
      "admin_rw public.fulfillment_step(uuid, text, text, text, text, text, inet)",
      "public_rw public.get_order_status(text)",
      "public_rw public.get_payment_secret()",
      "worker_rw public.get_payment_secret()",
      "admin_rw public.lock_program_contest(uuid)",
      // US-029: the console masks buyers and winners in SQL.
      "admin_rw public.mask_name(text)",
      "admin_rw public.mask_phone(text)",
      "admin_rw public.override_question_scoring(uuid, uuid, uuid, integer, integer, uuid, text, text, text, inet)",
      "public_rw public.play_answer(uuid, uuid, uuid, inet, bytea)",
      "public_rw public.play_attempts(uuid, uuid)",
      "public_rw public.play_current(uuid, uuid, inet, bytea)",
      "public_rw public.play_leaderboard(uuid, integer)",
      "public_rw public.play_note_unlocked(uuid, uuid)",
      "admin_rw public.play_program_ms(uuid)",
      "admin_rw public.play_ranking(uuid)",
      "public_rw public.play_reveal(uuid, uuid)",
      "public_rw public.play_settle(uuid, uuid)",
      "public_rw public.play_standing(uuid, uuid)",
      "public_rw public.play_start_set(uuid, uuid)",
      "admin_rw public.program_winners_banner(uuid)",
      "public_rw public.program_winners_banner(uuid)",
      "worker_rw public.prune_stranger_wa_contacts()",
      "public_rw public.record_waha_ack(text, text)",
      "admin_rw public.reinstate_winner(uuid, text, text, text, inet)",
      "admin_rw public.revoke_winner(uuid, text, text, text, inet)",
      "worker_rw public.sweep_login_throttle(integer)",
    ]);
  });

  it("keeps one sweep_login_throttle, taking the window (migration 0006 drops the argument-less one)", async () => {
    const rows = await sql<{ sig: string }[]>`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'sweep_login_throttle'`;
    expect(rows.map((r) => r.sig)).toEqual(["sweep_login_throttle(integer)"]);
  });
});

describe("public_rw denials", () => {
  it.each([
    ["INSERT outbox directly", "INSERT INTO public.outbox (topic, dedupe_key) VALUES ('otp.send', 'forged')"],
    ["read outbox", "SELECT id FROM public.outbox"],
    ["read admin_auth.user", 'SELECT id FROM admin_auth."user"'],
    ["read admin_auth.session", "SELECT id FROM admin_auth.session"],
    ["read admin_auth.account", "SELECT id FROM admin_auth.account"],
    ["read admin_auth.twoFactor", 'SELECT id FROM admin_auth."twoFactor"'],
    ["read admin_profiles", "SELECT id FROM public.admin_profiles"],
    ["read audit_log", "SELECT id FROM public.audit_log"],
    [
      "write audit_log",
      "INSERT INTO public.audit_log (actor_kind, action, entity_type) VALUES ('system', 'x', 'y')",
    ],
    ["read ad_spend", "SELECT id FROM public.ad_spend"],
    ["read settings_secrets (any scope)", "SELECT id FROM public.settings_secrets"],
    ["read payment secrets directly", "SELECT ciphertext FROM public.settings_secrets WHERE scope = 'payment'"],
    ["read the OTP cap ledger", "SELECT otp_id FROM public.otp_enqueues"],
    ["reset the OTP cap ledger", "DELETE FROM public.otp_enqueues"],
    ["re-point an OTP to another phone", "UPDATE public.player_otps SET phone = '+6281111111111'"],
    ["re-point a player's phone", "UPDATE public.players SET phone = '+6281111111111'"],
    [
      "forge eligibility (insert)",
      "INSERT INTO public.player_programs (player_id, program_id, eligible) VALUES (gen_random_uuid(), gen_random_uuid(), true)",
    ],
    ["forge eligibility (update)", "UPDATE public.player_programs SET eligible = true"],
    ["mark an order paid via paid_at", "UPDATE public.orders SET paid_at = now()"],
    ["reset the MO enqueue marker", "UPDATE public.orders SET mo_outbox_id = NULL"],
    ["reset a notification enqueue marker", "UPDATE public.payment_notifications SET outbox_id = NULL"],
    ["read deliveries", "SELECT id FROM public.deliveries"],
    ["read payments", "SELECT id FROM public.payments"],
    ["read conversion_events", "SELECT id FROM public.conversion_events"],
    ["read adnet postback templates", "SELECT mt_url_template FROM public.adnets"],
    ["read message templates", "SELECT id FROM public.message_templates"],
    // US-020: the checkout reads only its own columns of orders, and the keys of visits / consents.
    ["read a buyer's name from orders", "SELECT buyer_name FROM public.orders"],
    ["read a buyer's e-mail from orders", "SELECT buyer_email FROM public.orders"],
    ["read a buyer's IP from orders", "SELECT ip FROM public.orders"],
    ["read an order's attribution", "SELECT clickid, fbp, utm_source FROM public.orders"],
    ["read orders whole", "SELECT * FROM public.orders"],
    ["read a visit's IP", "SELECT ip FROM public.visits"],
    ["read a visit's attribution", "SELECT clickid FROM public.visits"],
    ["read a consent's IP", "SELECT ip FROM public.consents"],
    ["create a table", "CREATE TABLE public.intruder (id int)"],
    ["create a temp table", "CREATE TEMP TABLE intruder (id int)"],
  ])("cannot %s", async (_what, statement) => {
    expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });

  it("reads the checkout columns of orders and the keys of visits / consents (US-020)", async () => {
    await asRole("public_rw", async (tx) => {
      await tx`SELECT id, public_id, landing_page_id, buyer_phone, amount_idr, status, snap_attempt_count, snap_redirect_url,
                      snap_expires_at, expires_at, event_id, created_at FROM public.orders`;
      await tx`SELECT id, landing_page_id FROM public.visits`;
      await tx`SELECT id, order_id, legal_page_id, consented_at FROM public.consents`;
    });
  });

  it("can read adnet click-id params (column grant)", async () => {
    await asRole("public_rw", (tx) => tx`SELECT id, slug, clickid_param FROM public.adnets`);
  });

  it("gets only payment-scope secrets, still sealed, from get_payment_secret()", async () => {
    // settings_secrets_binding_check: only a conversions secret carries an adnet + bound host.
    const adnet = first(
      await sql<{ id: string }[]>`
        INSERT INTO adnets (slug, name, clickid_param, endpoint_host)
        VALUES ('probe-adnet', 'Probe', 'clickid', 'track.adnet.example') RETURNING id`,
    ).id;
    for (const scope of ["payment", "messaging", "conversions"]) {
      const bound = scope === "conversions" ? { adnet, host: "track.adnet.example" } : { adnet: null, host: null };
      await sql`
        INSERT INTO settings_secrets (scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
        VALUES (${scope}, ${`${scope}.probe_key`}, ${bound.adnet}, ${bound.host}, ${bytes(48)}, ${bytes(12)}, ${bytes(80)},
                ${`${scope}-k1`}, 'abcd')`;
    }
    for (const role of ["public_rw", "worker_rw"] as const) {
      const rows = await asRole(role, (tx) => tx<{ name: string; ciphertext: Buffer }[]>`SELECT * FROM get_payment_secret()`);
      expect(rows.map((r) => r.name)).toEqual(["payment.probe_key"]);
      expect(Buffer.isBuffer(first(rows).ciphertext)).toBe(true);
    }
  });
});

describe("internal_rw", () => {
  it("cannot EXECUTE get_payment_secret()", async () => {
    expect(await sqlState(asRole("internal_rw", (tx) => tx`SELECT * FROM get_payment_secret()`))).toBe("42501");
  });

  // US-023: the served hosts through the function only (no table read of lp_domains any more).
  it("can EXECUTE lp_served_hosts and INSERT alerts", async () => {
    await asRole("internal_rw", async (tx) => {
      await tx`SELECT host FROM public.lp_served_hosts()`;
      await tx`INSERT INTO public.alerts (source, kind, message) VALUES ('glitchtip', 'error', 'probe')`;
    });
  });

  it.each([
    ["read alerts", "SELECT id FROM public.alerts"],
    ["forge alert delivery state", "INSERT INTO public.alerts (source, kind, message, notified_at) VALUES ('internal', 'x', 'y', now())"],
    ["read landing pages", "SELECT id FROM public.landing_pages"],
    ["read lp_domains (US-023: lp_served_hosts only)", "SELECT host FROM public.lp_domains"],
    ["read lp_versions", "SELECT id FROM public.lp_versions"],
    ["read orders", "SELECT id FROM public.orders"],
    ["read settings_secrets", "SELECT id FROM public.settings_secrets"],
    ["INSERT outbox", "INSERT INTO public.outbox (topic, dedupe_key) VALUES ('alert.notify', 'forged')"],
    ["EXECUTE enqueue_otp", "SELECT enqueue_otp(gen_random_uuid())"],
    ["modify lp_domains", "DELETE FROM public.lp_domains"],
  ])("cannot %s", async (_what, statement) => {
    expect(await sqlState(asRole("internal_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });
});

describe("worker_rw denials", () => {
  it.each([
    // US-026: the OTP expiry sweeper finds rows by id and expires_at only; never the HMAC or a sealed code.
    ["read player OTP codes or their HMAC", "SELECT mac, sealed_code FROM public.player_otps"],
    ["read the OTP cap ledger", "SELECT otp_id FROM public.otp_enqueues"],
    ["read admin_auth", 'SELECT id FROM admin_auth."user"'],
    ["read player_auth", 'SELECT id FROM player_auth."user"'],
    ["create orders", "INSERT INTO public.orders (public_id) VALUES ('x')"],
    ["rewrite audit_log", "DELETE FROM public.audit_log"],
    ["EXECUTE enqueue_otp", "SELECT enqueue_otp(gen_random_uuid())"],
  ])("cannot %s", async (_what, statement) => {
    expect(await sqlState(asRole("worker_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });
});

// US-033 (security review M2): the console moves an order only through public.order_review_decide; it writes none of what a
// payment or a decision rests on, and it only ever adds an outbox row (test-sends, the Owner's re-query).
describe("admin_rw denials (US-033)", () => {
  it.each([
    ["create an order", "INSERT INTO public.orders (public_id) VALUES ('x')"],
    ["change an order", "UPDATE public.orders SET status = 'paid'"],
    ["delete an order", "DELETE FROM public.orders"],
    ["write a Midtrans attempt", "UPDATE public.midtrans_attempts SET gateway_status = 'settlement'"],
    ["create a Midtrans attempt", "INSERT INTO public.midtrans_attempts (order_id, n, midtrans_order_id) VALUES (gen_random_uuid(), 1, 'x-1')"],
    ["write the payments ledger", "UPDATE public.payments SET settled_at = now()"],
    ["create a payments ledger row", "INSERT INTO public.payments (order_id, gateway_txn_id, transaction_status, gross_amount_idr) VALUES (gen_random_uuid(), 'x', 'settlement', 1)"],
    ["forge a Midtrans notification", "INSERT INTO public.payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw) VALUES ('x-1', 'settlement', '200', 'x', '{}')"],
    ["change a Midtrans notification", "UPDATE public.payment_notifications SET processed_at = NULL"],
    ["delete a Midtrans notification", "DELETE FROM public.payment_notifications"],
    ["change an outbox row", "UPDATE public.outbox SET available_at = now()"],
    ["delete an outbox row", "DELETE FROM public.outbox"],
    ["write the decision ledger", "INSERT INTO public.order_owner_decisions (order_id, decision, from_status, to_status, attempts, reason, decided_by_admin_user_id, request_key) VALUES (gen_random_uuid(), 'paid', 'review', 'paid', '[]', 'a reason here', 'x', gen_random_uuid())"],
  ])("cannot %s (42501)", async (_what, statement) => {
    expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });

  it("still adds an outbox row of its two jobs (the test-send and the re-query), and no other topic (ET189)", async () => {
    const key = (topic: string) => `${topic}:${randomBytes(8).toString("hex")}`;
    for (const topic of ["payment.requery", "template.test_send"]) {
      await rolledBack("admin_rw", (tx) => tx`INSERT INTO public.outbox (topic, dedupe_key, payload) VALUES (${topic}, ${key(topic)}, '{}')`);
    }
    // A console session cannot take the payment code's own predictable key first (order.paid:<order id>), nor enqueue another job.
    for (const topic of ["order.paid", "payment.notification", "magic_link.resend", "otp.send"]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.outbox (topic, dedupe_key, payload) VALUES (${topic}, ${`${topic}:${randomBytes(16).toString("hex")}`}, '{}')`)), topic).toBe("ET189");
    }
    // Nor under an allowed topic: dedupe_key is unique across all topics, so another job's key is refused too (delta review M1).
    for (const squatted of ["order.paid:", "conversion.mo:", "magic_link.resend:", "template.test_send:"]) {
      const statement = (tx: Tx) => tx`INSERT INTO public.outbox (topic, dedupe_key, payload) VALUES ('payment.requery', ${`${squatted}${randomUUID()}`}, '{}')`;
      expect(await sqlState(asRole("admin_rw", statement)), squatted).toBe("ET189");
    }
    await rolledBack("admin_rw", (tx) => tx`INSERT INTO public.outbox (topic, dedupe_key, payload) VALUES ('payment.requery', ${`payment.requery:${randomUUID()}`}, '{}')`);
  });

  it("the outbox topic guard leaves the worker and a superuser alone (pg_has_role is true for a superuser on every role)", async () => {
    await rolledBack("worker_rw", (tx) => tx`INSERT INTO public.outbox (topic, dedupe_key, payload) VALUES ('order.paid', ${`order.paid:${randomBytes(16).toString("hex")}`}, '{}')`);
    await rolledBack(null, (tx) => tx`INSERT INTO public.outbox (topic, dedupe_key, payload) VALUES ('order.paid', ${`order.paid:${randomBytes(16).toString("hex")}`}, '{}')`);
  });
});

describe("audit_log is append-only", () => {
  const insertEntry = (tx: Tx) =>
    tx`INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs)
       VALUES ('admin', 'admin-1', 'product.update', 'product', 'p1',
               ${sql.json({ price_idr: { before: 50000, after: 45000 } })}, ${["player:1.phone changed"]})`;

  it("admin_rw can INSERT and SELECT", async () => {
    await asRole("admin_rw", async (tx) => {
      await insertEntry(tx);
      const rows = await tx`SELECT id FROM public.audit_log`;
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it.each([
    ["UPDATE", "UPDATE public.audit_log SET action = 'tampered'"],
    ["DELETE", "DELETE FROM public.audit_log"],
    ["TRUNCATE", "TRUNCATE public.audit_log"],
  ])("admin_rw cannot %s (42501)", async (_op, statement) => {
    expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });

  it.each([
    ["UPDATE", "UPDATE public.audit_log SET action = 'tampered'"],
    ["DELETE", "DELETE FROM public.audit_log"],
    ["TRUNCATE", "TRUNCATE public.audit_log"],
  ])("the owner and superusers cannot %s either (trigger, ET030)", async (_op, statement) => {
    await asRole("admin_rw", insertEntry);
    expect(await sqlState(asRole("migrator", (tx) => tx.unsafe(statement)))).toBe("ET030");
    expect(await sqlState(sql.unsafe(statement))).toBe("ET030");
  });

  // Security review item 7: entries could be forged with a chosen id, a backdated time or an
  // admin actor written by the worker.
  it("admin_rw cannot choose the id (OVERRIDING SYSTEM VALUE) or occurred_at (42501)", async () => {
    for (const statement of [
      `INSERT INTO public.audit_log (id, actor_kind, actor_admin_user_id, action, entity_type)
       OVERRIDING SYSTEM VALUE VALUES (-1, 'admin', 'admin-1', 'forged', 'product')`,
      `INSERT INTO public.audit_log (occurred_at, actor_kind, actor_admin_user_id, action, entity_type)
       VALUES ('2000-01-01', 'admin', 'admin-1', 'backdated', 'product')`,
    ]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
    }
  });

  it("worker_rw must write actor_kind = 'system' (ET031)", async () => {
    const forged = asRole(
      "worker_rw",
      (tx) => tx`
        INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type)
        VALUES ('admin', 'owner-1', 'winner.confirm', 'winner')`,
    );
    expect(await sqlState(forged)).toBe("ET031");
    // Fix round 2, LOW 4: a system entry must not name an admin either.
    const attributed = asRole(
      "worker_rw",
      (tx) => tx`
        INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type)
        VALUES ('system', 'owner-1', 'rescore.done', 'program')`,
    );
    expect(await sqlState(attributed)).toBe("ET031");
    await asRole(
      "worker_rw",
      (tx) => tx`INSERT INTO public.audit_log (actor_kind, action, entity_type) VALUES ('system', 'rescore.done', 'program')`,
    );
  });

  it("stamps occurred_at from the clock for every writer, even the owner", async () => {
    const [row] = await sql<{ occurred_at: Date; clock: Date }[]>`
      INSERT INTO audit_log (occurred_at, actor_kind, action, entity_type)
      VALUES ('2000-01-01T00:00:00Z', 'cli', 'probe', 'probe') RETURNING occurred_at, clock_timestamp() AS clock`;
    expect(Math.abs((row?.clock.getTime() ?? 0) - (row?.occurred_at.getTime() ?? 0))).toBeLessThan(5_000);
  });
});

describe("hardening", () => {
  it("gives PUBLIC nothing on the database, the schemas, tables or functions", async () => {
    expect((await privilegeMatrix()).filter((l) => l.startsWith("PUBLIC "))).toEqual([]);
  });

  it("gives objects migrator creates later no privileges for any app role or PUBLIC", async () => {
    await rolledBack("migrator", async (tx) => {
      await tx`CREATE TABLE public.leak_probe (id int)`;
      await tx`CREATE FUNCTION public.leak_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`;
      const rows = await tx<{ role: string; t: boolean; f: boolean }[]>`
        SELECT r AS role,
               has_table_privilege(r, 'public.leak_probe', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS t,
               has_function_privilege(r, 'public.leak_probe_fn()', 'EXECUTE') AS f
        FROM unnest(${[...APP_ROLES]}::text[]) r ORDER BY 1`;
      expect(rows).toEqual([...APP_ROLES].sort().map((role) => ({ role, t: false, f: false })));
      const acl = await tx`
        SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.proname = 'leak_probe_fn' AND a.grantee = 0`;
      expect(acl).toEqual([]);
    });
  });

  it("pins the full privilege matrix", async () => {
    expect(await privilegeMatrix()).toMatchSnapshot();
  });

  // Security review item 9: a table-level grant covers columns added later.
  it("pins the column list of every table public_rw / internal_rw reach by a table-level grant", async () => {
    const columns = await tableLevelGrantColumns();
    expect(columns).toMatchSnapshot();
    // The pin is sensitive: a new column on a public-readable table changes it.
    await rolledBack(null, async (tx) => {
      await tx`ALTER TABLE public.products ADD COLUMN cost_price_idr bigint`;
      expect(await tableLevelGrantColumns(tx)).not.toEqual(columns);
    });
  });

  // Security review item 3: leftovers revoked only from PUBLIC survived a re-run. Roles are
  // cluster-global, so the planted memberships are also cleaned up in `finally`.
  it("re-running every migration is a no-op and removes leftover grants, privileges and memberships", async () => {
    const before = await privilegeMatrix();
    const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    try {
      await sql`GRANT SELECT ON public.audit_log TO public_rw`;
      await sql`GRANT SELECT (id) ON public.ad_spend TO internal_rw`;
      await sql`GRANT EXECUTE ON FUNCTION public.get_payment_secret() TO internal_rw`;
      await sql`GRANT USAGE ON SCHEMA admin_auth TO public_rw`;
      await sql`GRANT CREATE ON SCHEMA public TO public_rw`;
      await sql.unsafe(`GRANT TEMPORARY, CREATE ON DATABASE "${db?.name ?? ""}" TO public_rw`);
      await sql`GRANT admin_rw TO public_rw`;
      await sql`GRANT pg_read_all_data TO internal_rw`;
      // Fix round 2: per-role search_path overrides and parameter privileges are leftovers too.
      await sql`ALTER ROLE worker_rw SET search_path = "$user", public`;
      await sql.unsafe(`ALTER ROLE public_rw IN DATABASE "${db?.name ?? ""}" SET search_path = "$user", public`);
      await sql`GRANT SET ON PARAMETER session_replication_role TO public_rw`;
      expect(await privilegeMatrix()).not.toEqual(before);
      expect(await groupMemberships()).toEqual(["internal_rw MEMBER OF pg_read_all_data", "public_rw MEMBER OF admin_rw"]);
      expect(await groupParameterPrivileges()).toEqual(["public_rw SET session_replication_role"]);

      await runMigrations(inject("dbUrl"));
      expect(await privilegeMatrix()).toEqual(before);
      expect(await groupMemberships()).toEqual([]);
      expect(await groupParameterPrivileges()).toEqual([]);
      expect(await roleSettings()).toEqual(["(database) search_path=public;idle_in_transaction_session_timeout=10min"]);
    } finally {
      await sql`REVOKE admin_rw FROM public_rw`;
      await sql`REVOKE pg_read_all_data FROM internal_rw`;
      await sql`ALTER ROLE worker_rw RESET ALL`;
      await sql.unsafe(`ALTER ROLE public_rw IN DATABASE "${db?.name ?? ""}" RESET ALL`);
      await sql`REVOKE ALL ON PARAMETER session_replication_role FROM public_rw`;
    }
  });

  // Defence in depth for item 3: an object in a managed schema that migrator does not own can
  // only be a plant; the migration refuses to run (ET090) instead of building on top of it.
  it("refuses to migrate while a managed schema holds an object migrator does not own (ET090)", async () => {
    await sql`CREATE FUNCTION public.planted_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`;
    try {
      await sql`ALTER FUNCTION public.planted_probe() OWNER TO public_rw`;
      expect(await sqlState(runMigrations(inject("dbUrl")))).toBe("ET090");
    } finally {
      await sql`DROP FUNCTION IF EXISTS public.planted_probe()`;
    }
    await runMigrations(inject("dbUrl"));
  });
});

// Fix round 2 (security re-review).
describe("search_path pinning and migration preflight", () => {
  // MUST FIX: with the default "$user", public, a schema named after the login user shadows our
  // unqualified tables for every session of that user.
  it("gives every new session search_path = public, whichever group the login belongs to", async () => {
    for (const group of GROUP_ROLES) {
      await withLoginRole([group], async (url) => {
        const fresh = postgres(url, { max: 1, onnotice: () => undefined });
        try {
          const [row] = await fresh<{ search_path: string }[]>`SHOW search_path`;
          expect({ group, searchPath: row?.search_path }).toEqual({ group, searchPath: "public" });
        } finally {
          await fresh.end();
        }
      });
    }
  });

  it("pins search_path = public on the app-style test connection (PG_CONNECTION_OPTIONS)", async () => {
    const [row] = await sql<{ search_path: string }[]>`SHOW search_path`;
    expect(row?.search_path).toBe("public");
  });

  it("refuses to migrate while a schema outside the managed set exists, e.g. one named after a role (ET090)", async () => {
    const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    const dbName = db?.name ?? "";
    // The reproduced plant: during a drift window internal_rw could CREATE on the database.
    await sql.unsafe(`GRANT CREATE ON DATABASE "${dbName}" TO internal_rw`);
    try {
      await asRole("internal_rw", async (tx) => {
        await tx`CREATE SCHEMA worker_rw`;
        await tx`CREATE TABLE worker_rw.settings_secrets (id uuid, scope text, name text, ciphertext bytea)`;
        await tx`CREATE TABLE worker_rw.outbox (id uuid, topic text)`;
        await tx`INSERT INTO worker_rw.settings_secrets VALUES (gen_random_uuid(), 'payment', 'planted', decode('00', 'hex'))`;
        await tx`GRANT USAGE ON SCHEMA worker_rw TO worker_rw`;
        await tx`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA worker_rw TO worker_rw`;
      });
      const error = await migrationError();
      expect(error).toBeInstanceOf(postgres.PostgresError);
      expect(error).toMatchObject({ code: "ET090" });
      expect((error as Error).message).toContain("schema worker_rw (internal_rw)");
      // LOW 1: the run was refused, yet the drift privilege that allowed the plant is gone.
      const [priv] = await sql<{ ok: boolean }[]>`SELECT has_database_privilege('internal_rw', current_database(), 'CREATE') AS ok`;
      expect(priv?.ok).toBe(false);
    } finally {
      await sql`DROP SCHEMA IF EXISTS worker_rw CASCADE`;
      await sql.unsafe(`REVOKE CREATE ON DATABASE "${dbName}" FROM internal_rw`);
    }
    await runMigrations(inject("dbUrl"));
  });

  // LOW 1: the reset used to roll back together with the refused run.
  it("removes leftover privileges even when the run is refused (ET090)", async () => {
    await sql`GRANT CREATE ON SCHEMA public TO public_rw`;
    await sql`CREATE FUNCTION public.planted_probe_2() RETURNS int LANGUAGE sql AS 'SELECT 1'`;
    try {
      await sql`ALTER FUNCTION public.planted_probe_2() OWNER TO public_rw`;
      expect(await sqlState(runMigrations(inject("dbUrl")))).toBe("ET090");
      const [priv] = await sql<{ ok: boolean }[]>`SELECT has_schema_privilege('public_rw', 'public', 'CREATE') AS ok`;
      expect(priv?.ok).toBe(false);
    } finally {
      await sql`DROP FUNCTION IF EXISTS public.planted_probe_2()`;
      await sql`REVOKE CREATE ON SCHEMA public FROM public_rw`;
    }
    await runMigrations(inject("dbUrl"));
  });

  // LOW 3: a login in two groups (e.g. public + worker) would pass every pg_has_role guard.
  it("refuses to migrate while a LOGIN role is in two groups, directly or indirectly (ET091)", async () => {
    await withLoginRole(["public_rw", "worker_rw"], async () => {
      expect(await sqlState(runMigrations(inject("dbUrl")))).toBe("ET091");
    });
    const middle = `ebt_mid_${randomBytes(4).toString("hex")}`;
    await sql.unsafe(`CREATE ROLE ${middle} NOLOGIN`);
    try {
      await sql.unsafe(`GRANT admin_rw TO ${middle}`);
      await withLoginRole(["public_rw", middle], async () => {
        expect(await sqlState(runMigrations(inject("dbUrl")))).toBe("ET091");
      });
    } finally {
      await sql.unsafe(`DROP ROLE IF EXISTS ${middle}`);
    }
    await withLoginRole(["worker_rw"], async () => {
      await runMigrations(inject("dbUrl"));
    });
  });

  // LOW 2: triggers enabled in mode 'O' do not fire under session_replication_role = replica.
  it("fires every trigger on our tables ALWAYS", async () => {
    const rows = await sql<{ trigger: string; enabled: string }[]>`
      SELECT c.relname || '.' || t.tgname AS trigger, t.tgenabled AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY 1`;
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(rows.filter((r) => r.enabled !== "A").map((r) => r.trigger)).toEqual([]);
  });

  it("keeps the guards under session_replication_role = replica", async () => {
    const underReplica = (role: "public_rw" | "admin_rw" | null, fn: (tx: Tx) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL session_replication_role = replica");
        if (role !== null) await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await fn(tx);
        throw new Error("statement succeeded under session_replication_role = replica");
      });

    await sql`INSERT INTO audit_log (actor_kind, action, entity_type) VALUES ('cli', 'probe', 'probe')`;
    expect(await sqlState(underReplica(null, (tx) => tx`UPDATE public.audit_log SET action = 'tampered'`))).toBe("ET030");

    const { productId, programId } = await createProgram();
    const landingPageId = await createLandingPage(programId);
    const paid = orderRow({ landingPageId, programId, productId, status: "paid" });
    expect(await sqlState(underReplica("public_rw", (tx) => tx`INSERT INTO public.orders ${tx(paid)}`))).toBe("ET040");

    const { setId, q1 } = await createTriviaSet(programId);
    const { playerId } = await createPlayer({ programId, eligible: true });
    await createAttempt(playerId, setId);
    expect(
      await sqlState(underReplica("admin_rw", (tx) => tx`UPDATE public.questions SET points = 99 WHERE id = ${q1.id}`)),
    ).toBe("ET020");
  });
});
