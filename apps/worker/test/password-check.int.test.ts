// US-031 (ASVS V6.2.12): the breached-password check of an admin password, in the worker (the Owner's choice: the console
// has no egress). The console writes admin_profiles.password_check_id and an admin.password_hibp_check outbox row (payload
// admin_user_id + check_id, `sealed` = the password's SHA-1 sealed to the messaging key); this consumer opens it, asks the
// range API (always a FAKE here: never the real Have I Been Pwned) and flags a breached password through
// flag_breached_admin_password. Every end of a job wipes the sealed hash.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { PwnedLookup, PwnedResult } from "@ebooktrivia/adapters/pwned-passwords";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createPasswordCheckConsumer, PASSWORD_CHECK_MAX_ATTEMPTS, PASSWORD_CHECK_TOPIC } from "../src/password-check.ts";
import { sweepExpiredOtps } from "../src/sweepers.ts";
import { first, sql, suffix } from "./support/db.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});

const keys = generateScopeKeyPair();
const sealer = createSecretSealer({ messaging: keys.publicKey });
const opener = createSecretOpener({ messaging: keys.privateKey });
const sha1Of = (password: string): string => createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();

function capturedLog() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  return { lines, log: createLogger({ level: "info", role: "worker" }, stream) };
}

/** A fake range API: answers `result` and records the hashes it was asked for. */
function fakeLookup(result: PwnedResult): PwnedLookup & { readonly asked: string[] } {
  const asked: string[] = [];
  const lookup = (sha1: string): Promise<PwnedResult> => {
    asked.push(sha1);
    return Promise.resolve(result);
  };
  return Object.assign(lookup, { asked });
}

/** An admin account and a password set on it, the way the console records it (lib/auth/password-check.ts). */
async function adminWithPassword(role: "owner" | "staff"): Promise<{ userId: string; password: string; checkId: string; outboxId: string }> {
  const userId = randomBytes(18).toString("base64url");
  const password = `a long passphrase ${suffix()} ${suffix()}`;
  await sql`
    INSERT INTO admin_auth."user" (id, name, email, "emailVerified", "twoFactorEnabled")
    VALUES (${userId}, 'Admin', ${`pwcheck-${suffix()}@example.test`}, true, true)`;
  const checkId = randomUUID();
  await sql`INSERT INTO admin_profiles (auth_user_id, role, display_name, password_check_id) VALUES (${userId}, ${role}, 'Admin', ${checkId})`;
  const outboxId = randomUUID();
  const sealed = sealer.sealPasswordCheck({ checkId, adminUserId: userId, password });
  await sql`
    INSERT INTO outbox (id, topic, dedupe_key, payload, sealed)
    VALUES (${outboxId}, ${PASSWORD_CHECK_TOPIC}, ${`${PASSWORD_CHECK_TOPIC}:${checkId}`}, ${sql.json({ admin_user_id: userId, check_id: checkId })}, ${sealed})`;
  return { userId, password, checkId, outboxId };
}

const run = (lookup: PwnedLookup, log = capturedLog().log) =>
  createOutboxProcessor(createPasswordCheckConsumer({ opener, lookup, log }), { sql: workerSql, failpoint: inertFailpoint, log });

const state = async (who: { userId: string; outboxId: string }) => ({
  row: first(await sql<{ processed: boolean; sealed: Buffer | null; last_error: string | null; attempts: number; payload: unknown }[]>`
    SELECT processed_at IS NOT NULL AS processed, sealed, last_error, attempts, payload FROM outbox WHERE id = ${who.outboxId}`),
  breached: first(await sql<{ breached: boolean }[]>`SELECT password_breached_at IS NOT NULL AS breached FROM admin_profiles WHERE auth_user_id = ${who.userId}`).breached,
  alerts: await sql<{ severity: string; source: string; payload: unknown; message: string }[]>`
    SELECT severity, source, payload, message FROM alerts WHERE kind = 'admin_password_breached' AND payload->>'admin_user_id' = ${who.userId}`,
  audits: await sql<{ actor_kind: string; changes: unknown }[]>`
    SELECT actor_kind, changes FROM audit_log WHERE action = 'admin_user.password_breached' AND entity_id = ${who.userId}`,
});

describe("admin.password_hibp_check (US-031, ASVS V6.2.12; the range API is a fake)", () => {
  it("flags a breached password of an Owner and of a Staff member: the flag, one warning alert with the admin id only, an audit row; the hash is wiped", async () => {
    for (const role of ["owner", "staff"] as const) {
      const who = await adminWithPassword(role);
      const lookup = fakeLookup({ status: "breached", count: 12 });
      const { lines, log } = capturedLog();
      expect(await run(lookup, log)({ id: who.outboxId })).toBe("processed");
      expect(lookup.asked).toEqual([sha1Of(who.password)]);
      const after = await state(who);
      expect(after.breached, role).toBe(true);
      expect(after.row).toMatchObject({ processed: true, sealed: null, last_error: null });
      expect(after.alerts).toEqual([{ severity: "warning", source: "worker", payload: { admin_user_id: who.userId }, message: expect.stringContaining("known data breach") as string }]);
      expect(after.audits).toEqual([{ actor_kind: "system", changes: { must_change_password: { before: false, after: true } } }]);
      // Neither the password nor any form of its hash in the log, the alert or the row.
      const sha1 = sha1Of(who.password);
      for (const secret of [who.password, sha1, sha1.slice(0, 5), sha1.slice(5), sha1.toLowerCase()]) {
        expect(lines.join("\n")).not.toContain(secret);
        expect(JSON.stringify(after)).not.toContain(secret);
      }
      // A re-run of the job (a crash before the finalize) flags nothing twice.
      expect(await sql`SELECT public.flag_breached_admin_password(${who.userId}, ${who.checkId}) AS flagged`).toEqual([{ flagged: false }]);
    }
  });

  it("leaves a clean password alone, and still wipes the hash", async () => {
    const who = await adminWithPassword("staff");
    expect(await run(fakeLookup({ status: "clean" }))({ id: who.outboxId })).toBe("processed");
    const after = await state(who);
    expect(after).toMatchObject({ breached: false, alerts: [], audits: [], row: { processed: true, sealed: null } });
  });

  it("retries an unreachable API with backoff, then gives up without a flag (fail open), and wipes the hash at the end", async () => {
    const who = await adminWithPassword("owner");
    const lookup = fakeLookup({ status: "unavailable", reason: "timeout" });
    for (let attempt = 1; attempt < PASSWORD_CHECK_MAX_ATTEMPTS; attempt++) {
      await expect(run(lookup)({ id: who.outboxId })).rejects.toThrow("pwned passwords unavailable: timeout");
      const during = await state(who);
      expect(during.row).toMatchObject({ processed: false, attempts: attempt, last_error: "pwned passwords unavailable: timeout" });
      expect(during.row.sealed).not.toBeNull();
      expect(first(await sql<{ later: boolean }[]>`SELECT available_at > now() AS later FROM outbox WHERE id = ${who.outboxId}`).later).toBe(true);
      await sql`UPDATE outbox SET available_at = now() WHERE id = ${who.outboxId}`;
    }
    const { lines, log } = capturedLog();
    expect(await run(lookup, log)({ id: who.outboxId })).toBe("processed");
    expect(lookup.asked).toHaveLength(PASSWORD_CHECK_MAX_ATTEMPTS);
    const after = await state(who);
    expect(after).toMatchObject({ breached: false, alerts: [], row: { processed: true, sealed: null, attempts: PASSWORD_CHECK_MAX_ATTEMPTS } });
    expect(lines.join("\n")).toContain("password check given up");
  });

  it("never flags a password that was changed since its check (the admin's current check id moved on)", async () => {
    const who = await adminWithPassword("staff");
    await sql`UPDATE admin_profiles SET password_check_id = ${randomUUID()} WHERE auth_user_id = ${who.userId}`;
    expect(await run(fakeLookup({ status: "breached", count: 3 }))({ id: who.outboxId })).toBe("processed");
    expect(await state(who)).toMatchObject({ breached: false, alerts: [], audits: [], row: { processed: true, sealed: null } });
  });

  it("carries the admin and check ids only: the payload never holds the password or its hash, and a row that does not open is dropped", async () => {
    const who = await adminWithPassword("owner");
    const { row } = await state(who);
    expect(row.payload).toEqual({ admin_user_id: who.userId, check_id: who.checkId });
    expect(row.sealed?.includes(Buffer.from(sha1Of(who.password)))).toBe(false);
    expect(row.sealed?.includes(Buffer.from(who.password))).toBe(false);
    // Sealed to another key (or relabelled to another admin): never opened, never looked up, the hash still wiped.
    const other = createSecretSealer({ messaging: generateScopeKeyPair().publicKey });
    await sql`UPDATE outbox SET sealed = ${other.sealPasswordCheck({ checkId: who.checkId, adminUserId: who.userId, password: who.password })} WHERE id = ${who.outboxId}`;
    const lookup = fakeLookup({ status: "breached", count: 1 });
    const { lines, log } = capturedLog();
    expect(await run(lookup, log)({ id: who.outboxId })).toBe("processed");
    expect(lookup.asked).toEqual([]);
    expect(lines.join("\n")).toContain("unreadable_hash");
    expect(await state(who)).toMatchObject({ breached: false, row: { processed: true, sealed: null } });
  });

  it("loses its sealed hash to the minute sweep when it never ends: past the attempt cap, or 24 h old; a live job keeps it (delta review LOW)", async () => {
    const capped = await adminWithPassword("owner");
    const stale = await adminWithPassword("staff");
    const live = await adminWithPassword("staff");
    // The last claim failed after the lookup (its finalize never ran): the cap is reached, the row is not processed.
    await sql`UPDATE outbox SET attempts = ${PASSWORD_CHECK_MAX_ATTEMPTS} WHERE id = ${capped.outboxId}`;
    // No worker held the messaging key for a day: never claimed.
    await sql`UPDATE outbox SET created_at = clock_timestamp() - interval '25 hours' WHERE id = ${stale.outboxId}`;
    // A deferred claim raises the cap: attempts = cap with one deferral is still live.
    await sql`UPDATE outbox SET attempts = ${PASSWORD_CHECK_MAX_ATTEMPTS}, deferrals = 1 WHERE id = ${live.outboxId}`;
    const swept = await sweepExpiredOtps(workerSql);
    expect(swept.checks).toBeGreaterThanOrEqual(2);
    expect((await state(capped)).row).toMatchObject({ processed: false, sealed: null });
    expect((await state(stale)).row).toMatchObject({ processed: false, sealed: null });
    expect((await state(live)).row.sealed).not.toBeNull();
    // The flag is never touched by the sweep.
    for (const who of [capped, stale, live]) expect((await state(who)).breached).toBe(false);
  });

  it("lets only the worker flag, and only through the function: worker_rw has no privilege on admin_profiles, admin_rw cannot call it", async () => {
    const who = await adminWithPassword("staff");
    await expect(workerSql`UPDATE admin_profiles SET password_breached_at = now() WHERE auth_user_id = ${who.userId}`).rejects.toMatchObject({ code: "42501" });
    await expect(workerSql`SELECT password_check_id FROM admin_profiles WHERE auth_user_id = ${who.userId}`).rejects.toMatchObject({ code: "42501" });
    for (const role of ["admin_rw", "public_rw", "internal_rw"]) {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx`SELECT public.flag_breached_admin_password(${who.userId}, ${who.checkId})`;
        }),
        role,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await workerSql`SELECT public.flag_breached_admin_password(${who.userId}, ${who.checkId}) AS flagged`).toEqual([{ flagged: true }]);
  });
});
