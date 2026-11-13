// Startup check (security review US-013 #3b): each process must connect as a login in exactly its
// own group role. A superuser, or a login that is also in another group, would silently widen what
// a compromised process can reach (pg_has_role is true for every group for a superuser, so that is
// refused too).
import type postgres from "postgres";
import { ConfigError } from "./env.ts";

const APP_GROUPS = ["public_rw", "admin_rw", "worker_rw", "internal_rw", "migrator"] as const;

export async function assertLoginRole(sql: postgres.Sql, group: "worker_rw" | "internal_rw", variable: string): Promise<void> {
  const rows = await sql<{ role: string; member: boolean }[]>`
    SELECT r AS role, pg_has_role(current_user, r, 'MEMBER') AS member
      FROM unnest(${[...APP_GROUPS]}::text[]) AS r`;
  const groups = rows.filter((r) => r.member).map((r) => r.role);
  if (groups.length !== 1 || groups[0] !== group) {
    throw new ConfigError(`${variable} must be ${group === "internal_rw" ? "an" : "a"} ${group} login`);
  }
}
