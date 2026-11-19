// Least privilege at startup (US-009 carry-over R3): each app process must connect as a LOGIN role
// whose only group is its own (public_rw, admin_rw, worker_rw, internal_rw). A superuser is a member
// of every group (pg_has_role), so it is refused too. Used by apps/worker and apps/admin.
import type postgres from "postgres";

export const APP_GROUPS = ["public_rw", "admin_rw", "worker_rw", "internal_rw", "migrator"] as const;
export type AppGroup = (typeof APP_GROUPS)[number];

/** The app groups the current login is a member of (directly or through other roles). */
export async function loginGroups(sql: postgres.Sql): Promise<AppGroup[]> {
  const rows = await sql<{ role: AppGroup; member: boolean }[]>`
    SELECT r AS role, pg_has_role(current_user, r, 'MEMBER') AS member FROM unnest(${[...APP_GROUPS]}::text[]) AS r`;
  return rows.filter((r) => r.member).map((r) => r.role);
}

/** True when the current login is in `group` and in no other app group. */
export async function isOnlyMemberOf(sql: postgres.Sql, group: Exclude<AppGroup, "migrator">): Promise<boolean> {
  const groups = await loginGroups(sql);
  return groups.length === 1 && groups[0] === group;
}
