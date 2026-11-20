// Lockout after 5 failures in 15 minutes, per account and per client address (IPv6 by /64), held
// in PostgreSQL: it survives a restart and applies across instances, and concurrent guesses cannot
// exceed the budget. The second factor also has a long-term budget: 20 consecutive failures, across
// windows, hard-lock it until the recovery CLI (security review US-016 SM2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverAdminUser } from "../src/lib/admin-users.ts";
import { runMutation } from "../src/lib/audit.ts";
import { signInWithPassword, startEnrollment, verifyTotpSignIn } from "../src/lib/auth/service.ts";
import { beginAttempt, MAX_CONSECUTIVE, MAX_FAILURES, throttleKey } from "../src/lib/auth/throttle.ts";
import { throttleBucket } from "@ebooktrivia/edge";
import { auditRows, codeFor, CookieJar, createTestAdmin, enroll, type Enrolled, freshIp, newRuntime, password, passwordStep, root, system, wrongTotp } from "./support.ts";

const rt = newRuntime();
const WRONG = "definitely-not-the-password";

async function attempt(email: string, pw: string, ip: string, runtime = rt) {
  return (await system(() => signInWithPassword(runtime, { email, password: pw }, new CookieJar().request(ip)), ip)).outcome;
}

describe("password lockout", () => {
  it("locks the account after 5 failures: the right password is refused for 15 minutes, from any address", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    const outcomes = [];
    for (let i = 0; i < MAX_FAILURES; i++) outcomes.push((await attempt(admin.email, WRONG, ip)).kind);
    expect(outcomes).toEqual(["invalid", "invalid", "invalid", "invalid", "locked"]);
    expect(await attempt(admin.email, admin.password, ip)).toMatchObject({ kind: "locked" });
    expect(await attempt(admin.email, admin.password, freshIp())).toMatchObject({ kind: "locked" });
    expect(await attempt(admin.email.toUpperCase(), admin.password, freshIp())).toMatchObject({ kind: "locked" });
    const [lock] = await auditRows(admin.userId, "admin_auth.locked_out");
    expect(lock).toMatchObject({ actor_kind: "system", changes: { step: "password", account: true } });
    expect(await auditRows(admin.userId, "admin_auth.sign_in_failed")).toHaveLength(MAX_FAILURES);
  });

  it("unlocks after the 15 minute lock and window have passed", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES; i++) await attempt(admin.email, WRONG, ip);
    expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("locked");
    const key = throttleKey("account", admin.email);
    await root`UPDATE admin_auth.login_throttle SET locked_until = clock_timestamp() - interval '1 second',
                window_started_at = clock_timestamp() - interval '16 minutes' WHERE key = ${key}`;
    expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("enroll");
  });

  it("counts failures only within the 15 minute window", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES - 1; i++) await attempt(admin.email, WRONG, ip);
    await root`UPDATE admin_auth.login_throttle SET window_started_at = clock_timestamp() - interval '15 minutes 1 second'
                WHERE key = ${throttleKey("account", admin.email)}`;
    // A new window: one more failure does not lock.
    expect((await attempt(admin.email, WRONG, freshIp())).kind).toBe("invalid");
    expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("enroll");
  });

  it("locks a client address after 5 failures, whichever accounts it tries (no enumeration: unknown e-mails count too)", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES; i++) await attempt(`nobody-${String(i)}@example.test`, WRONG, ip);
    expect((await attempt(admin.email, admin.password, ip)).kind).toBe("locked");
    expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("enroll");
  });

  it("keys IPv6 clients by /64", async () => {
    const admin = await createTestAdmin(rt);
    for (let i = 0; i < MAX_FAILURES; i++) await attempt(`nobody-${String(i)}@example.test`, WRONG, `2001:db8:77:1::${(i + 1).toString(16)}`);
    expect((await attempt(admin.email, admin.password, "2001:db8:77:1:ffff::9")).kind).toBe("locked");
    expect((await attempt(admin.email, admin.password, "2001:db8:77:2::1")).kind).toBe("enroll");
  });

  it("survives a restart and holds across instances (state in PostgreSQL)", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    const a = newRuntime();
    const b = newRuntime();
    for (let i = 0; i < 3; i++) await attempt(admin.email, WRONG, freshIp(), a);
    for (let i = 0; i < 2; i++) await attempt(admin.email, WRONG, freshIp(), b);
    await a.close();
    const restarted = newRuntime();
    expect((await attempt(admin.email, admin.password, ip, restarted)).kind).toBe("locked");
  });

  it("lets at most 5 of many concurrent guesses reach the password check", async () => {
    const admin = await createTestAdmin(rt);
    const instances = [newRuntime(), newRuntime(), newRuntime(), newRuntime()];
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(admin.email, WRONG, freshIp(), instances[i % 4])));
    // Every password check that ran wrote one sign_in_failed row: exactly the budget, no more.
    expect(await auditRows(admin.userId, "admin_auth.sign_in_failed")).toHaveLength(MAX_FAILURES);
    expect(outcomes.filter((o) => o.kind === "invalid").length).toBeLessThan(MAX_FAILURES);
    expect(outcomes.filter((o) => o.kind === "locked").length).toBeGreaterThanOrEqual(20 - MAX_FAILURES);
    expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("locked");
  });

  it("clears the account after a completed sign-in: failures, then password + second factor, start over", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES - 2; i++) await attempt(admin.email, WRONG, ip);
    expect(await signInWithCode(admin)).toEqual({ kind: "signed_in" });
    for (let i = 0; i < MAX_FAILURES - 1; i++) expect((await attempt(admin.email, WRONG, freshIp())).kind).toBe("invalid");
  });

  it("refuses a blocked attempt without counting it", async () => {
    const key = throttleKey("ip", `test-${String(Date.now())}`);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const gate = await beginAttempt(rt.sql, [key]);
      if (!gate.allowed) throw new Error("blocked too early");
      await gate.attempt.failed();
    }
    const blocked = await beginAttempt(rt.sql, [key]);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThan(14 * 60);
    const [row] = await root<{ failures: number }[]>`SELECT failures FROM admin_auth.login_throttle WHERE key = ${key}`;
    expect(row?.failures).toBe(MAX_FAILURES);
  });
});

/** Lets the 15 minute window of the account's password key pass (unfinished sign-ins count, F1). */
async function accountWindowPasses(email: string): Promise<void> {
  await root`UPDATE admin_auth.login_throttle SET locked_until = NULL, failures = 0 WHERE key = ${throttleKey("account", email)}`;
}

/** Lets the 15 minute lock and window of `key` (and Better Auth's own TOTP lock) pass, as if 16 minutes went by. */
async function windowPasses(userId: string, email?: string): Promise<void> {
  if (email !== undefined) await accountWindowPasses(email);
  await root`UPDATE admin_auth.login_throttle SET locked_until = CASE WHEN locked_until IS NULL THEN NULL ELSE clock_timestamp() - interval '1 second' END,
              window_started_at = clock_timestamp() - interval '16 minutes' WHERE key = ${throttleKey("second_factor", userId)}`;
  await root`UPDATE admin_auth."twoFactor" SET "lockedUntil" = NULL, "failedVerificationCount" = 0 WHERE "userId" = ${userId}`;
}

/** `n` wrong authenticator codes for `admin`, each from a fresh challenge and address. */
async function wrongCodes(admin: Enrolled, n: number): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < n; i++) {
    const ip = freshIp();
    const jar = await passwordStep(rt, admin, ip);
    const res = await system(() => verifyTotpSignIn(rt, { code: wrongTotp(admin.secret) }, jar.request(ip)), ip);
    kinds.push(res.outcome.kind === "locked" && res.outcome.permanent ? "hard_locked" : res.outcome.kind);
  }
  return kinds;
}

async function signInWithCode(admin: Enrolled) {
  const ip = freshIp();
  const jar = await passwordStep(rt, admin, ip);
  return (await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, jar.request(ip)), ip)).outcome;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("second-factor lockout", () => {
  it("locks the account's second factor after 5 wrong authenticator codes, from any address", async () => {
    const admin = await enroll(rt);
    expect((await wrongCodes(admin, MAX_FAILURES)).at(-1)).toBe("locked");
    await accountWindowPasses(admin.email);
    expect(await signInWithCode(admin)).toMatchObject({ kind: "locked", permanent: false });
  });

  it("hard-locks after 20 consecutive failures spread over windows; the right code stays refused after the window", async () => {
    const admin = await enroll(rt);
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    for (let round = 0; round < MAX_CONSECUTIVE / MAX_FAILURES; round++) {
      const kinds = await wrongCodes(admin, MAX_FAILURES);
      expect(kinds.at(-1), `round ${String(round)}`).toBe(round === MAX_CONSECUTIVE / MAX_FAILURES - 1 ? "hard_locked" : "locked");
      await windowPasses(admin.userId, admin.email);
    }
    expect(await signInWithCode(admin)).toMatchObject({ kind: "locked", permanent: true });
    const [row] = await root<{ consecutive: number; hard: boolean }[]>`
      SELECT consecutive, hard_locked_at IS NOT NULL AS hard FROM admin_auth.login_throttle WHERE key = ${throttleKey("second_factor", admin.userId)}`;
    expect(row).toEqual({ consecutive: MAX_CONSECUTIVE, hard: true });
    expect(await auditRows(admin.userId, "admin_auth.second_factor_hard_locked")).toHaveLength(1);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["event"] === "admin.second_factor_locked");
    expect(logged).toEqual([expect.objectContaining({ level: "warn", userId: admin.userId })]);

    // Only the recovery CLI clears it (and a new enrollment follows).
    const fresh = password();
    expect(await runMutation({ actor: { kind: "cli" }, requestId: "test", ip: null }, () => recoverAdminUser(rt.sql, admin.email, fresh))).toMatchObject({ kind: "recovered" });
    expect(await root`SELECT 1 FROM admin_auth.login_throttle WHERE key = ${throttleKey("second_factor", admin.userId)}`).toHaveLength(0);
    const again = await enroll(rt, "staff", { userId: admin.userId, email: admin.email, password: fresh });
    expect(await signInWithCode(again)).toEqual({ kind: "signed_in" });
  });

  it("a successful sign-in resets the consecutive count", async () => {
    const admin = await enroll(rt);
    for (let round = 0; round < 3; round++) {
      await wrongCodes(admin, MAX_FAILURES);
      await windowPasses(admin.userId, admin.email);
    }
    await wrongCodes(admin, MAX_FAILURES - 1);
    expect(await signInWithCode(admin)).toEqual({ kind: "signed_in" });
    expect(await root`SELECT 1 FROM admin_auth.login_throttle WHERE key = ${throttleKey("second_factor", admin.userId)}`).toHaveLength(0);
    // 19 more failures (another 4 windows) do not hard-lock: the count started again at 0.
    for (let round = 0; round < 3; round++) {
      await wrongCodes(admin, MAX_FAILURES);
      await windowPasses(admin.userId, admin.email);
    }
    expect((await wrongCodes(admin, MAX_FAILURES - 1)).includes("hard_locked")).toBe(false);
  });

  it("the password step has no hard lock (anyone could lock out the Owner by e-mail)", async () => {
    // Also through the service: 25 correct passwords without a second factor never hard-lock anything.
    const admin = await enroll(rt);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < MAX_FAILURES; i++) await passwordStep(rt, admin, freshIp());
      await accountWindowPasses(admin.email);
    }
    expect(await signInWithCode(admin)).toEqual({ kind: "signed_in" });
    const key = throttleKey("account", `nobody-${String(Date.now())}@example.test`);
    for (let i = 0; i < MAX_CONSECUTIVE + MAX_FAILURES; i++) {
      const gate = await beginAttempt(rt.sql, [key]);
      if (!gate.allowed) {
        await root`UPDATE admin_auth.login_throttle SET locked_until = clock_timestamp() - interval '1 second', window_started_at = clock_timestamp() - interval '16 minutes' WHERE key = ${key}`;
        continue;
      }
      expect((await gate.attempt.failed()).hardLocked).toEqual([]);
    }
    const [row] = await root<{ consecutive: number; hard: boolean }[]>`SELECT consecutive, hard_locked_at IS NOT NULL AS hard FROM admin_auth.login_throttle WHERE key = ${key}`;
    expect(row).toEqual({ consecutive: 0, hard: false });
  });
});

describe("unfinished sign-ins (security review US-016 F1)", () => {
  it("count a correct password until the second factor completes: the 6th in 15 minutes is refused", async () => {
    const admin = await enroll(rt);
    for (let i = 0; i < MAX_FAILURES; i++) await passwordStep(rt, admin, freshIp());
    expect(await attempt(admin.email, admin.password, freshIp())).toMatchObject({ kind: "locked", permanent: false });
    // Bounded audit: one password_verified row per allowed attempt, none for the refused one.
    expect(await auditRows(admin.userId, "admin_auth.password_verified")).toHaveLength(MAX_FAILURES);
  });

  it("count for an account that has not enrolled yet too (password-only sessions)", async () => {
    const admin = await createTestAdmin(rt);
    for (let i = 0; i < MAX_FAILURES; i++) expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("enroll");
    expect((await attempt(admin.email, admin.password, freshIp())).kind).toBe("locked");
    const sessions = await root`SELECT 1 FROM admin_auth.session WHERE "userId" = ${admin.userId}`;
    expect(sessions).toHaveLength(MAX_FAILURES);
  });

  it("a completed second factor clears the account key and refunds the address of the password step", async () => {
    const admin = await enroll(rt);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await passwordStep(rt, admin, freshIp());
    const ip = freshIp();
    const jar = await passwordStep(rt, admin, ip);
    const res = await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, jar.request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "signed_in" });
    expect(await root`SELECT 1 FROM admin_auth.login_throttle WHERE key = ${throttleKey("account", admin.email)}`).toHaveLength(0);
    const [address] = await root<{ failures: number }[]>`SELECT failures FROM admin_auth.login_throttle WHERE key = ${throttleKey("ip", throttleBucket(ip))}`;
    expect(address?.failures ?? 0).toBe(0);
    for (let i = 0; i < MAX_FAILURES; i++) await passwordStep(rt, admin, freshIp());
  });

  it("a completed enrollment clears the account key", async () => {
    const admin = await createTestAdmin(rt);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await attempt(admin.email, admin.password, freshIp());
    await enroll(rt, "staff", admin);
    expect(await root`SELECT 1 FROM admin_auth.login_throttle WHERE key = ${throttleKey("account", admin.email)}`).toHaveLength(0);
  });
});

describe("enrollment step 1 (security review US-016 G1)", () => {
  it("counts a successful step 1 until enrollment completes: the 6th in 15 minutes is refused", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    const jar = new CookieJar();
    jar.apply((await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, jar.request(ip)), ip)).setCookies);
    let current = admin.password;
    for (let i = 0; i < MAX_FAILURES; i++) {
      const next = password();
      const res = await system(() => startEnrollment(rt, { userId: admin.userId }, { password: current, newPassword: next }, jar.request(freshIp())), ip);
      expect(res.kind, `step 1 #${String(i + 1)}`).toBe("verify");
      current = next;
    }
    const sixth = await system(() => startEnrollment(rt, { userId: admin.userId }, { password: current, newPassword: password() }, jar.request(freshIp())), ip);
    expect(sixth).toMatchObject({ kind: "locked", permanent: false });
    expect(await auditRows(admin.userId, "admin_auth.totp_enrollment_started")).toHaveLength(MAX_FAILURES);
  });
});

describe("address refund at sign-in completion (security review US-016 G2)", () => {
  async function addressFailures(ip: string): Promise<number> {
    const [row] = await root<{ failures: number }[]>`SELECT failures FROM admin_auth.login_throttle WHERE key = ${throttleKey("ip", throttleBucket(ip))}`;
    return row?.failures ?? 0;
  }

  it("refunds nothing when the code comes from another address than the password step", async () => {
    const admin = await enroll(rt);
    const x = freshIp();
    const y = freshIp();
    await attempt(`nobody-${String(Date.now())}-a@example.test`, WRONG, x);
    await attempt(`nobody-${String(Date.now())}-b@example.test`, WRONG, x);
    expect(await addressFailures(x)).toBe(2);
    const jar = await passwordStep(rt, admin, y);
    const res = await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, jar.request(x)), x);
    expect(res.outcome).toEqual({ kind: "signed_in" });
    expect(await addressFailures(x)).toBe(2);
    expect(await addressFailures(y)).toBe(1);
  });

  it("refunds the password step's address when the same address completes", async () => {
    const admin = await enroll(rt);
    const x = freshIp();
    await attempt(`nobody-${String(Date.now())}-c@example.test`, WRONG, x);
    const jar = await passwordStep(rt, admin, x);
    expect(await addressFailures(x)).toBe(2);
    const res = await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, jar.request(x)), x);
    expect(res.outcome).toEqual({ kind: "signed_in" });
    expect(await addressFailures(x)).toBe(1);
  });

  it("refunds an address once per password step from it, however many completions follow", async () => {
    const admin = await enroll(rt);
    const x = freshIp();
    await attempt(`nobody-${String(Date.now())}-d@example.test`, WRONG, x);
    await attempt(`nobody-${String(Date.now())}-e@example.test`, WRONG, x);
    const fromX = await passwordStep(rt, admin, x);
    const fromY = await passwordStep(rt, admin, freshIp());
    for (const jar of [fromX, fromY]) {
      const res = await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, jar.request(x)), x);
      expect(res.outcome).toEqual({ kind: "signed_in" });
    }
    expect(await addressFailures(x)).toBe(2);
  });
});
