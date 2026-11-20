// Shared helpers for the admin integration tests: a superuser connection for setup / inspection,
// an app runtime connected as the admin_rw login, a browser-like cookie jar, TOTP codes as the
// authenticator app makes them (@ebooktrivia/test-support/totp, with a used-codes set per user so
// the replay protection never trips a test), and the mutation scope the action wrappers open.
import { randomBytes } from "node:crypto";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { freshTotp } from "@ebooktrivia/test-support/totp";
import postgres from "postgres";
import { afterAll, expect, inject } from "vitest";
import { createAdminUser } from "../src/lib/admin-users.ts";
import { runMutation } from "../src/lib/audit.ts";
import { runtimeFor, type AuthRuntime } from "../src/lib/auth/runtime.ts";
import { completeEnrollment, type RequestInfo, signInWithPassword, startEnrollment } from "../src/lib/auth/service.ts";
import type { AdminConfig, AuthSecret } from "../src/lib/config.ts";
import { createAdminDb } from "../src/lib/db.ts";
import type { Role } from "../src/lib/policy.ts";
import { NO_SETTINGS, type SettingsConfig } from "../src/lib/settings/env.ts";

export { totp, wrongTotp } from "@ebooktrivia/test-support/totp";

export const root = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });

export const SECRET_V1: AuthSecret = { version: 1, value: randomBytes(32).toString("hex") };

export const TEST_CONFIG: AdminConfig = {
  production: false,
  origin: "http://127.0.0.1:3299",
  authSecrets: [SECRET_V1],
  databaseUrl: inject("adminDbUrl"),
};

const runtimes: AuthRuntime[] = [];
/** A runtime on its own pool (a second instance of the app, or the app after a restart). */
export function newRuntime(config: AdminConfig = TEST_CONFIG, settings: SettingsConfig = NO_SETTINGS): AuthRuntime {
  const rt = runtimeFor(config, createAdminDb(config.databaseUrl, 8), settings);
  runtimes.push(rt);
  return rt;
}

afterAll(async () => {
  await Promise.all(runtimes.map((rt) => rt.close()));
  await root.end({ timeout: 5 });
});

export const suffix = (): string => randomBytes(4).toString("hex");
export const password = (): string => `pw-${randomBytes(12).toString("hex")}`;
/**
 * A client address in a /64 of its own (2001:db8::/32, documentation range), so throttle buckets
 * never collide between tests or test files on the shared database.
 */
export const freshIp = (): string => `2001:db8:${randomBytes(2).readUInt16BE().toString(16)}:${randomBytes(2).readUInt16BE().toString(16)}::1`;

export function system<T>(fn: () => Promise<T>, ip: string | null = null): Promise<T> {
  return runMutation({ actor: { kind: "system" }, requestId: `test-${suffix()}`, ip }, fn);
}

export function asAdmin<T>(userId: string, fn: () => Promise<T>, ip: string | null = null): Promise<T> {
  return runMutation({ actor: { kind: "admin", userId }, requestId: `test-${suffix()}`, ip }, fn);
}

const usedCodes = new Map<string, Set<string>>();
/** An authenticator code for `userId` the console has not seen yet (see freshTotp). */
export function codeFor(userId: string, secret: string): Promise<string> {
  let used = usedCodes.get(userId);
  if (used === undefined) usedCodes.set(userId, (used = new Set()));
  return freshTotp(secret, used);
}

/** Cookies as a browser keeps them: Set-Cookie with Max-Age=0 / Expires in the past deletes. */
export class CookieJar {
  readonly cookies = new Map<string, string>();
  readonly seen: string[] = [];

  apply(setCookies: readonly string[]): void {
    for (const header of setCookies) {
      this.seen.push(header);
      const [pair = "", ...attrs] = header.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      const expires = attrs.find((a) => a.toLowerCase().startsWith("expires="));
      const gone = (maxAge !== undefined && Number(maxAge.slice(8)) <= 0) || (expires !== undefined && Date.parse(expires.slice(8)) <= Date.now()) || value === "";
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  request(ip: string): RequestInfo {
    const headers = new Headers({ "x-forwarded-for": ip, "user-agent": "admin-int-test" });
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    return { headers, ip };
  }
}

export interface TestAdmin {
  readonly userId: string;
  readonly email: string;
  /** The current password (the temporary one until enrollment replaced it). */
  readonly password: string;
}

/** A fresh admin account (no TOTP yet, 72 h to enroll), created as the system. */
export async function createTestAdmin(rt: AuthRuntime, role: Role = "staff"): Promise<TestAdmin> {
  const email = `admin-${suffix()}@example.test`;
  const pw = password();
  const created = await system(() => createAdminUser(rt.sql, { email, displayName: `Admin ${suffix()}`, password: pw }, role, "admin_user.create"));
  if (created.kind !== "created") throw new Error(`createAdminUser: ${created.kind}`);
  return { userId: created.userId, email, password: pw };
}

export interface Enrolled extends TestAdmin {
  readonly secret: string;
  readonly recoveryCodes: readonly string[];
  readonly jar: CookieJar;
}

/** Signs in (temporary password), enrolls TOTP with a new password; returns the secret + codes. */
export async function enroll(rt: AuthRuntime, role: Role = "staff", admin?: TestAdmin): Promise<Enrolled> {
  const account = admin ?? (await createTestAdmin(rt, role));
  const jar = new CookieJar();
  const ip = freshIp();
  const signIn = await system(() => signInWithPassword(rt, { email: account.email, password: account.password }, jar.request(ip)), ip);
  expect(signIn.outcome).toEqual({ kind: "enroll" });
  jar.apply(signIn.setCookies);
  const newPassword = password();
  const started = await system(() => startEnrollment(rt, { userId: account.userId }, { password: account.password, newPassword }, jar.request(ip)), ip);
  if (started.kind !== "verify") throw new Error(`startEnrollment: ${started.kind}`);
  const done = await system(async () => completeEnrollment(rt, { userId: account.userId }, { code: await codeFor(account.userId, started.secret) }, jar.request(ip)), ip);
  expect(done.outcome).toEqual({ kind: "enrolled" });
  jar.apply(done.setCookies);
  return { ...account, password: newPassword, secret: started.secret, recoveryCodes: started.recoveryCodes, jar };
}

/** The password step of an enrolled account; returns the jar holding the second-factor challenge. */
export async function passwordStep(rt: AuthRuntime, admin: TestAdmin, ip: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const res = await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, jar.request(ip)), ip);
  expect(res.outcome).toEqual({ kind: "second_factor" });
  jar.apply(res.setCookies);
  return jar;
}

export async function auditRows(entityId: string | null, action?: string) {
  return root<{ id: number; actor_kind: string; actor_admin_user_id: string | null; action: string; entity_id: string | null; changes: Record<string, unknown>; pii_refs: string[]; ip: string | null; request_id: string | null }[]>`
    SELECT id, actor_kind, actor_admin_user_id, action, entity_id, changes, pii_refs, host(ip) AS ip, request_id
      FROM audit_log
     WHERE entity_id IS NOT DISTINCT FROM ${entityId} ${action === undefined ? root`` : root`AND action = ${action}`}
     ORDER BY id`;
}
