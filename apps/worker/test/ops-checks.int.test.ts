// US-015: the backup, WAL and Valkey-memory alerts (src/ops-checks.ts) as worker_rw on a real database. The WAL check reads
// PostgreSQL's own archiver view; on the test server archive_mode is off, so it must stay silent (and its query must run).
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { BACKUP_MAX_AGE_HOURS, checkBackups, checkValkeyMemory, checkWalArchive, OPS_CHECK_MAX_AGE_HOURS, parseMemory, WAL_LAG_MINUTES } from "../src/ops-checks.ts";
import { sql } from "./support/db.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 2, onnotice: () => undefined });
afterAll(async () => {
  // The alerts these tests raise are critical and unsent: no later file should find them.
  await sql`DELETE FROM public.alerts WHERE kind IN ('backup_base_stale', 'backup_restic_stale', 'ops_check_stale', 'wal_archive_lag', 'valkey_memory_high')`;
  await sql`DELETE FROM public.heartbeats WHERE component IN ('backup_base', 'backup_restic', 'ops_check')`;
  await workerSql.end({ timeout: 5 });
});

const unresolved = async (kind: string): Promise<{ severity: string; message: string }[]> =>
  sql<{ severity: string; message: string }[]>`SELECT severity, message FROM public.alerts WHERE kind = ${kind} AND resolved_at IS NULL`;
const beat = async (component: string, hoursAgo: number): Promise<void> => {
  await sql`
    INSERT INTO public.heartbeats (component, beat_at, info) VALUES (${component}, now() - make_interval(hours => ${hoursAgo}), '{}'::jsonb)
    ON CONFLICT (component) DO UPDATE SET beat_at = EXCLUDED.beat_at`;
};

beforeEach(async () => {
  await sql`DELETE FROM public.alerts WHERE kind IN ('backup_base_stale', 'backup_restic_stale', 'ops_check_stale', 'wal_archive_lag', 'valkey_memory_high')`;
  await sql`DELETE FROM public.heartbeats WHERE component IN ('backup_base', 'backup_restic', 'ops_check')`;
});

describe("checkBackups", () => {
  it("raises a critical alert for a backup that never succeeded, and none for a recent one", async () => {
    expect(await checkBackups(workerSql)).toBe(3);
    expect((await unresolved("backup_base_stale"))[0]).toMatchObject({ severity: "critical" });
    expect((await unresolved("backup_base_stale"))[0]?.message).toContain("has never succeeded");
    await sql`DELETE FROM public.alerts WHERE kind IN ('backup_base_stale', 'backup_restic_stale', 'ops_check_stale')`;
    await beat("backup_base", 3);
    await beat("backup_restic", BACKUP_MAX_AGE_HOURS - 1);
    await beat("ops_check", 0);
    expect(await checkBackups(workerSql)).toBe(0);
  });

  it("raises it past 26 hours, once an hour while it lasts (the alert's own dedupe)", async () => {
    await beat("backup_base", BACKUP_MAX_AGE_HOURS + 2);
    await beat("backup_restic", 1);
    await beat("ops_check", 0);
    expect(await checkBackups(workerSql)).toBe(1);
    expect(await checkBackups(workerSql)).toBe(0);
    const [alert] = await unresolved("backup_base_stale");
    expect(alert?.message).toContain("has not succeeded for 26 hours");
    expect(await unresolved("backup_restic_stale")).toEqual([]);
  });

  it("raises ops_check_stale when the VM's disk and pg_wal check (every 5 minutes) has not reported for an hour: the disk and WAL alerts would not run", async () => {
    await beat("backup_base", 1);
    await beat("backup_restic", 1);
    await beat("ops_check", OPS_CHECK_MAX_AGE_HOURS + 1);
    expect(await checkBackups(workerSql)).toBe(1);
    const [alert] = await unresolved("ops_check_stale");
    expect(alert).toMatchObject({ severity: "critical" });
    expect(alert?.message).toContain("the free-disk and pg_wal alerts are not running");
  });
});

/**
 * checkWalArchive on the worker's pool, except that the one statement reading PostgreSQL's archiver view answers `rows`: archive_mode cannot be
 * turned on in the test server (it needs a restart), so a lagging archiver is told to the check. The alert it raises is written for real.
 * The statement must be intercepted exactly once per call, or the case would silently test the real archiver view (silent in the test server).
 */
async function walCheck(rows: { mode: string; since_archived_s: number | null; failing: boolean; up_s: number }[]): Promise<boolean> {
  let intercepted = 0;
  const pool = new Proxy(workerSql, {
    apply: (target, thisArg: unknown, args: unknown[]) => {
      const text = Array.isArray(args[0]) ? (args[0] as string[]).join("") : "";
      if (!text.includes("pg_stat_archiver")) return Reflect.apply(target, thisArg, args) as Promise<unknown>;
      intercepted++;
      return Promise.resolve(rows);
    },
  });
  const raised = await checkWalArchive(pool);
  expect(intercepted).toBe(1);
  return raised;
}
const MINUTE = 60;

describe("checkWalArchive", () => {
  it("stays silent where archive_mode is off (the test server) and runs its query as worker_rw", async () => {
    expect(await checkWalArchive(workerSql)).toBe(false);
    expect(await unresolved("wal_archive_lag")).toEqual([]);
  });

  it("stays silent when the archiver view has no row, when archive_mode is off, when PostgreSQL has been up under 15 minutes, and while the last archive is recent", async () => {
    for (const rows of [
      [],
      [{ mode: "off", since_archived_s: null, failing: false, up_s: 99 * 3600 }],
      [{ mode: "on", since_archived_s: null, failing: false, up_s: WAL_LAG_MINUTES * MINUTE }],
      [{ mode: "on", since_archived_s: WAL_LAG_MINUTES * MINUTE, failing: true, up_s: 99 * 3600 }],
    ]) {
      expect(await walCheck(rows)).toBe(false);
    }
    expect(await unresolved("wal_archive_lag")).toEqual([]);
  });

  it("raises ONE critical alert when nothing was archived for 15 minutes, and says when the archive command is failing", async () => {
    const lagging = { mode: "on", since_archived_s: WAL_LAG_MINUTES * MINUTE + 1, failing: false, up_s: 99 * 3600 };
    expect(await walCheck([lagging])).toBe(true);
    // The alert's own dedupe: still lagging a minute later, still one open alert.
    expect(await walCheck([{ ...lagging, failing: true }])).toBe(false);
    const alerts = await sql<{ severity: string; message: string; payload: unknown }[]>`SELECT severity, message, payload FROM public.alerts WHERE kind = 'wal_archive_lag' AND resolved_at IS NULL`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", payload: { failing: false } });
    expect(alerts[0]?.message).toContain("has archived no WAL for 15 minutes:");
    expect(alerts[0]?.message).not.toContain("failing");

    // Never archived at all (no last_archived_time) and the command failing: the alert names it.
    await sql`DELETE FROM public.alerts WHERE kind = 'wal_archive_lag'`;
    expect(await walCheck([{ mode: "on", since_archived_s: null, failing: true, up_s: 99 * 3600 }])).toBe(true);
    const [failing] = await unresolved("wal_archive_lag");
    expect(failing?.message).toContain("minutes and the archive command is failing:");
  });
});

describe("Valkey memory", () => {
  it("parses INFO memory and ignores a Valkey without maxmemory", () => {
    expect(parseMemory("# Memory\r\nused_memory:1000\r\nused_memory_human:1K\r\nmaxmemory:2000\r\nmaxmemory_human:2K\r\n")).toEqual({ used: 1000, max: 2000 });
    expect(parseMemory("used_memory:1000\r\nmaxmemory:0\r\n")).toBeNull();
    expect(parseMemory("nothing useful")).toBeNull();
  });

  it("raises a warning at 70 % of maxmemory and not below", async () => {
    expect(await checkValkeyMemory(workerSql, () => Promise.resolve("used_memory:690\r\nmaxmemory:1000\r\n"))).toBe(false);
    expect(await unresolved("valkey_memory_high")).toEqual([]);
    expect(await checkValkeyMemory(workerSql, () => Promise.resolve("used_memory:700\r\nmaxmemory:1000\r\n"))).toBe(true);
    const [alert] = await unresolved("valkey_memory_high");
    expect(alert).toMatchObject({ severity: "warning" });
    expect(alert?.message).toContain("70 %");
  });
});
