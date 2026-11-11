import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { PostgresDialect } from "kysely";
import type pg from "pg";
import { BASE_URL, SECRET } from "./env.ts";
import type { OtpStore } from "./otp-store.ts";

type SecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;
type AuthPlugin = NonNullable<BetterAuthOptions["plugins"]>[number];

export const UNIFORM_BODY = { message: "code sent" };

export interface PlayerOpts {
  pool: pg.Pool;
  cookiePrefix?: string;
  /** Called by the stock phone-number send-otp endpoint (never for non-eligible phones when gated). */
  sendOtp: (phone: string, code: string) => Promise<void>;
  /**
   * Eligibility gate on /phone-number/send-otp via hooks.before.
   * "shortcircuit": hook answers for every phone (eligible ones are handled by enqueueOtp, plugin endpoint never runs).
   * "passthrough": hook only answers for non-eligible phones; eligible ones fall through to the plugin endpoint.
   */
  gate?: { enqueueOtp: (phone: string) => Promise<boolean>; mode: "shortcircuit" | "passthrough" };
  /** When set, verification uses the HMAC table instead of Better Auth's verification row. */
  otpStore?: OtpStore;
  storeIdentifier?: "plain" | "hashed";
  secondaryStorage?: SecondaryStorage;
  rateLimit?: BetterAuthOptions["rateLimit"];
  advanced?: BetterAuthOptions["advanced"];
  signUpOnVerification?: boolean;
  plugins?: AuthPlugin[];
}

function phoneFromBody(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "phoneNumber" in body && typeof body.phoneNumber === "string") {
    return body.phoneNumber;
  }
  return null;
}

export function createPlayerAuth(o: PlayerOpts) {
  const { gate, otpStore } = o;
  const options = {
    appName: "spike-player",
    baseURL: BASE_URL,
    secret: SECRET,
    database: { dialect: new PostgresDialect({ pool: o.pool }), type: "postgres", schemaName: "player_auth" },
    advanced: { cookiePrefix: o.cookiePrefix ?? "play", ...o.advanced },
    // Players have no passwords: stock password/reset routes are switched off.
    disabledPaths: ["/sign-in/phone-number", "/phone-number/request-password-reset", "/phone-number/reset-password"],
    ...(o.secondaryStorage ? { secondaryStorage: o.secondaryStorage } : {}),
    ...(o.rateLimit ? { rateLimit: o.rateLimit } : {}),
    verification: {
      storeInDatabase: true,
      ...(o.storeIdentifier ? { storeIdentifier: o.storeIdentifier } : {}),
    },
    session: { storeSessionInDatabase: true },
    ...(gate
      ? {
          hooks: {
            before: createAuthMiddleware(async (ctx) => {
              if (ctx.path !== "/phone-number/send-otp") return;
              const phone = phoneFromBody(ctx.body);
              if (phone === null) return;
              const eligible = await gate.enqueueOtp(phone);
              if (!eligible || gate.mode === "shortcircuit") return ctx.json(UNIFORM_BODY);
              return;
            }),
          },
        }
      : {}),
    plugins: [
      phoneNumber({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        sendOTP: ({ phoneNumber: phone, code }) => o.sendOtp(phone, code),
        ...(otpStore ? { verifyOTP: ({ phoneNumber: phone, code }) => otpStore.verify(phone, code) } : {}),
        ...(o.signUpOnVerification
          ? { signUpOnVerification: { getTempEmail: (p: string) => `${p}@players.invalid` } }
          : {}),
      }),
      ...(o.plugins ?? []),
    ],
  } satisfies BetterAuthOptions;
  return { auth: betterAuth(options), options: options as BetterAuthOptions };
}

export function createAdminAuth(pool: pg.Pool) {
  const options = {
    appName: "spike-admin",
    baseURL: BASE_URL,
    secret: SECRET,
    database: { dialect: new PostgresDialect({ pool }), type: "postgres", schemaName: "admin_auth" },
    advanced: { cookiePrefix: "adm" },
    emailAndPassword: { enabled: true },
  } satisfies BetterAuthOptions;
  return { auth: betterAuth(options), options: options as BetterAuthOptions };
}

export async function migrate(options: BetterAuthOptions): Promise<string> {
  const { runMigrations, compileMigrations } = await getMigrations(options);
  const sql = await compileMigrations();
  await runMigrations();
  return sql;
}

export interface Resp {
  status: number;
  body: string;
  headers: Headers;
  setCookies: string[];
}

export async function post(
  auth: { handler: (r: Request) => Promise<Response> },
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...extraHeaders },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.text(), headers: res.headers, setCookies: res.headers.getSetCookie() };
}
