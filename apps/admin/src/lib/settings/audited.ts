// One way to run an audited settings change and turn the database's own refusals into form
// messages (code review US-017 L5): InvalidInput passes through, a PostgreSQL error whose SQLSTATE is
// in `messages` becomes InvalidInput with that text, anything else propagates (adminAction logs it
// and answers with a bare error).
import { type AuditRecorder, type Tx, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { InvalidInput, sqlState } from "./fields.ts";

/** Two first saves raced on a unique key (code review US-017 L9): the user may simply retry. */
export const CONCURRENT_SAVE = "Someone saved this at the same moment. Reload the page and try again.";

export async function auditedChange<T>(sql: Sql, mutate: (tx: Tx, audit: AuditRecorder) => Promise<T>, messages: Readonly<Record<string, string>> = {}): Promise<T> {
  try {
    return await withAudit(sql, mutate);
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    const message = messages[sqlState(error) ?? ""];
    if (message !== undefined) throw new InvalidInput(message);
    throw error;
  }
}
