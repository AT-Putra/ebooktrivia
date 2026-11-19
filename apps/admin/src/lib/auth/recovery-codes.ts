// Recovery code storage (admin_auth.recovery_code): argon2id hashes only, single use, every use
// audited in the same transaction that marks the code used.
import { randomBytes } from "node:crypto";
import { type Tx, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { hashSecret, verifySecret } from "./argon2.ts";
import { formatRecoveryCode, generateRecoveryCodes, normalizeRecoveryCode, selectorOf } from "./recovery-format.ts";

let dummyHash: Promise<string> | undefined;
/** A hash no code matches: verified when there is no candidate row, so both paths cost one verification. */
const timingDummy = (): Promise<string> => (dummyHash ??= hashSecret(randomBytes(16).toString("hex")));

/** Fresh hashed codes, ready for `storeRecoveryCodes` (hashing happens outside any transaction). */
export async function prepareRecoveryCodes(): Promise<{ readonly shown: string[]; readonly rows: { selector: string; hash: string }[] }> {
  const codes = generateRecoveryCodes();
  const rows = await Promise.all(codes.map(async (code) => ({ selector: selectorOf(code), hash: await hashSecret(code) })));
  return { shown: codes.map(formatRecoveryCode), rows };
}

/**
 * Replaces every code of `userId` with `rows`, on the caller's transaction. The user row is locked
 * first, so two concurrent replacements run one after the other and never leave 20 codes.
 */
export async function storeRecoveryCodes(tx: Tx, userId: string, rows: readonly { selector: string; hash: string }[]): Promise<number> {
  const [user] = await tx`SELECT id FROM admin_auth."user" WHERE id = ${userId} FOR UPDATE`;
  if (user === undefined) throw new Error("no such admin user");
  const removed = await tx`DELETE FROM admin_auth.recovery_code WHERE user_id = ${userId}`;
  for (const row of rows) {
    await tx`INSERT INTO admin_auth.recovery_code (user_id, selector, code_hash) VALUES (${userId}, ${row.selector}, ${row.hash})`;
  }
  return removed.count;
}

class AlreadyUsed extends Error {}

/** True when `input` is an unused code of `userId`; that code is then used up (and audited). */
export async function consumeRecoveryCode(sql: Sql, userId: string, input: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  const [row] =
    normalized === null
      ? []
      : await sql<{ id: string; code_hash: string }[]>`
          SELECT id, code_hash FROM admin_auth.recovery_code
           WHERE user_id = ${userId} AND selector = ${selectorOf(normalized)} AND used_at IS NULL`;
  const matches = await verifySecret(row?.code_hash ?? (await timingDummy()), normalized ?? "-");
  if (row === undefined || !matches) return false;
  try {
    return await withAudit(sql, async (tx, audit) => {
      const used = await tx`UPDATE admin_auth.recovery_code SET used_at = clock_timestamp() WHERE id = ${row.id} AND used_at IS NULL RETURNING id`;
      if (used.length === 0) throw new AlreadyUsed();
      const [left] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_auth.recovery_code WHERE user_id = ${userId} AND used_at IS NULL`;
      audit({
        action: "admin_auth.recovery_code_used",
        entityType: "admin_user",
        entityId: userId,
        facts: { remaining: left?.n ?? 0 },
        actor: { kind: "admin", userId },
      });
      return true;
    });
  } catch (error) {
    if (error instanceof AlreadyUsed) return false;
    throw error;
  }
}

export async function unusedRecoveryCodes(sql: Sql, userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_auth.recovery_code WHERE user_id = ${userId} AND used_at IS NULL`;
  return row?.n ?? 0;
}
