// Better Auth 1.7.19 option sets whose plugin lists decide the DDL of the `player_auth` and
// `admin_auth` schemas. Only schema-relevant options live here; the apps (M5a admin, M9 player)
// own the runtime config. If an app adds a plugin that adds tables or columns, add it here too:
// `test/better-auth.int.test.ts` then fails until `src/schema/auth.ts` matches again.
import type { BetterAuthOptions } from "better-auth";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { twoFactor } from "better-auth/plugins/two-factor";
import { PostgresDialect } from "kysely";
import type pg from "pg";

const DDL_ONLY_SECRET = "ddl-generation-only-not-a-real-secret-0123456789";
const BASE_URL = "http://localhost:3000";

export function playerAuthOptions(pool: pg.Pool): BetterAuthOptions {
  return {
    appName: "ebooktrivia-player",
    baseURL: BASE_URL,
    secret: DDL_ONLY_SECRET,
    database: { dialect: new PostgresDialect({ pool }), type: "postgres", schemaName: "player_auth" },
    plugins: [
      phoneNumber({
        sendOTP: () => {
          throw new Error("DDL generation only");
        },
      }),
    ],
  };
}

export function adminAuthOptions(pool: pg.Pool): BetterAuthOptions {
  return {
    appName: "ebooktrivia-admin",
    baseURL: BASE_URL,
    secret: DDL_ONLY_SECRET,
    database: { dialect: new PostgresDialect({ pool }), type: "postgres", schemaName: "admin_auth" },
    emailAndPassword: { enabled: true },
    plugins: [twoFactor()],
  };
}
