// Startup check (security review US-013 #3b): each process must connect as a login in exactly its
// own group role. A superuser, or a login that is also in another group, would silently widen what
// a compromised process can reach (pg_has_role is true for every group for a superuser, so that is
// refused too). The check itself is shared with apps/admin (@ebooktrivia/db/login-role).
import { isOnlyMemberOf } from "@ebooktrivia/db/login-role";
import type postgres from "postgres";
import { ConfigError } from "./env.ts";

export async function assertLoginRole(sql: postgres.Sql, group: "worker_rw" | "internal_rw", variable: string): Promise<void> {
  if (!(await isOnlyMemberOf(sql, group))) {
    throw new ConfigError(`${variable} must be ${group === "internal_rw" ? "an" : "a"} ${group} login`);
  }
}
