// Operational alerts of the backup and Valkey side (US-015, plan M4.8 "internal checks"): sweepers that raise `alerts` rows, which the
// alert relay (alert-relay.ts) sends to the Owner. They run only where the VM's backups exist (WORKER_OPS_CHECKS, on in production):
//   backup_base_stale / backup_restic_stale   the nightly jobs (infra/backup/walg-base-backup.sh, restic-backup.sh) record their success in
//                                             heartbeats (components backup_base, backup_restic); older than 26 hours, or never, is critical;
//   wal_archive_lag                           PostgreSQL's own archiver view says nothing was archived for 15 minutes while archive_mode is on
//                                             (the worker's own heartbeat keeps WAL moving, so a quiet database is not a lagging one), critical;
//   valkey_memory_high                        Valkey's used_memory is above 70 % of maxmemory (it runs noeviction: a full Valkey fails every write),
//                                             warning. `public` can write rl:* and cache:public:* keys (all with TTLs); this is the net under them.
//   ops_check_stale                           the VM's own disk and pg_wal check (infra/backup/ops-check.sh, every 5 minutes: free disk, the size of
//                                             pg_wal) has not reported for an hour; it raises disk_free_low / disk_free_critical / pg_wal_large itself,
//                                             because only the host sees its disks and only a superuser may list pg_wal (heartbeat ops_check).
// Every message is fixed text: no name, address or number, nothing from a payload.
import type postgres from "postgres";
import { raiseAlert } from "./sweepers.ts";

export const BACKUP_MAX_AGE_HOURS = 26;
export const OPS_CHECK_MAX_AGE_HOURS = 1;
export const WAL_LAG_MINUTES = 15;
export const VALKEY_MEMORY_RATIO = 0.7;

const BACKUPS = [
  { component: "backup_base", kind: "backup_base_stale", what: "The nightly wal-g base backup", maxAgeHours: BACKUP_MAX_AGE_HOURS },
  { component: "backup_restic", kind: "backup_restic_stale", what: "The nightly restic backup", maxAgeHours: BACKUP_MAX_AGE_HOURS },
  // infra/backup/ops-check.sh runs every 5 minutes: an hour without a report means the timer is gone, and with it the disk and pg_wal alerts.
  { component: "ops_check", kind: "ops_check_stale", what: "The VM's disk and WAL check", maxAgeHours: OPS_CHECK_MAX_AGE_HOURS },
] as const;

/** Raises one critical alert per backup job (and the VM's own disk check) whose last success is older than its limit or missing. Returns how many. */
export async function checkBackups(sql: postgres.Sql): Promise<number> {
  let raised = 0;
  for (const { component, kind, what, maxAgeHours } of BACKUPS) {
    const [row] = await sql<{ age_hours: number | null }[]>`
      SELECT (extract(epoch FROM now() - beat_at) / 3600)::float8 AS age_hours FROM public.heartbeats WHERE component = ${component}`;
    if (row !== undefined && row.age_hours !== null && row.age_hours <= maxAgeHours) continue;
    const since = row === undefined ? "has never succeeded" : `has not succeeded for ${String(maxAgeHours)} hours`;
    const ok = await raiseAlert(sql, {
      kind,
      severity: "critical",
      dedupeKey: kind,
      message: `${what} ${since} (heartbeat ${component}): ${component === "ops_check" ? "the free-disk and pg_wal alerts are not running" : "the restore point is getting older"}; see docs/runbooks/backups.md`,
      payload: { component },
    });
    if (ok) raised++;
  }
  return raised;
}

/** Critical when PostgreSQL archives WAL (archive_mode on) and has archived nothing for 15 minutes, once it has been up that long. */
export async function checkWalArchive(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ mode: string; since_archived_s: number | null; failing: boolean; up_s: number }[]>`
    SELECT current_setting('archive_mode') AS mode,
           extract(epoch FROM now() - last_archived_time)::int AS since_archived_s,
           coalesce(last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time), false) AS failing,
           extract(epoch FROM now() - pg_postmaster_start_time())::int AS up_s
      FROM pg_stat_archiver`;
  if (row === undefined || row.mode === "off") return false;
  const limit = WAL_LAG_MINUTES * 60;
  if (row.up_s <= limit || (row.since_archived_s !== null && row.since_archived_s <= limit)) return false;
  return raiseAlert(sql, {
    kind: "wal_archive_lag",
    severity: "critical",
    dedupeKey: "wal_archive_lag",
    message: `PostgreSQL has archived no WAL for ${String(WAL_LAG_MINUTES)} minutes${row.failing ? " and the archive command is failing" : ""}: point-in-time recovery is not covering the latest changes; see docs/runbooks/backups.md`,
    payload: { failing: row.failing },
  });
}

/** used_memory and maxmemory (bytes) of a Valkey INFO memory text, or null when maxmemory is not set. */
export function parseMemory(info: string): { readonly used: number; readonly max: number } | null {
  const value = (name: string): number => {
    const m = new RegExp(`^${name}:(\\d+)\\s*$`, "m").exec(info);
    return m?.[1] === undefined ? Number.NaN : Number(m[1]);
  };
  const used = value("used_memory");
  const max = value("maxmemory");
  return Number.isFinite(used) && Number.isFinite(max) && max > 0 ? { used, max } : null;
}

/** Warning once Valkey's used_memory passes 70 % of maxmemory. */
export async function checkValkeyMemory(sql: postgres.Sql, info: () => Promise<string>): Promise<boolean> {
  const memory = parseMemory(await info());
  if (memory === null || memory.used / memory.max < VALKEY_MEMORY_RATIO) return false;
  return raiseAlert(sql, {
    kind: "valkey_memory_high",
    severity: "warning",
    dedupeKey: "valkey_memory_high",
    message: `Valkey uses ${String(Math.round((memory.used / memory.max) * 100))} % of its maxmemory (limit ${String(Math.round(VALKEY_MEMORY_RATIO * 100))} %), and it runs noeviction: when it is full every write fails; look for rl: and cache: keys without a TTL`,
    payload: { usedBytes: memory.used, maxBytes: memory.max },
  });
}
