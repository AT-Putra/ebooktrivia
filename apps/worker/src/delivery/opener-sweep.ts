// The lease of an opener (US-025, Owner decision D7). A process that dies between the claim and the record leaves the opener `sending`: after its lease
// it becomes `unknown` (it may have been sent) and is NEVER sent again (core delivery-opener expireOpenerLease, ET131 in the database). Nothing is raised:
// an opener that may have gone out is no problem for the Owner (the buyer has the ebook by e-mail, and a reply to the opener, if it arrived, is handled by
// the buyer-first path). Run with the minute sweepers (index.ts).
import { expireOpenerLease, type OpenerStatus } from "@ebooktrivia/core";
import type postgres from "postgres";
import { openerColumns } from "./deliver.ts";

const BATCH = 100;

export async function expireOpenerLeases(sql: postgres.Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      { delivery_id: string; status: OpenerStatus; attempts: number; session_id: string | null; tried_session_ids: string[]; next_attempt_at: Date | null; lease_until: Date | null; now: Date }[]
    >`
      SELECT delivery_id, status, attempts, session_id, tried_session_ids, next_attempt_at, lease_until, clock_timestamp() AS now
        FROM public.delivery_openers
       WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < now())
       ORDER BY lease_until NULLS FIRST LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
    let expired = 0;
    for (const row of rows) {
      const decision = expireOpenerLease(
        { status: row.status, attempts: row.attempts, sessionId: row.session_id, triedSessionIds: row.tried_session_ids, nextAttemptAt: row.next_attempt_at, leaseUntil: row.lease_until },
        row.now,
      );
      if (!decision.ok) continue;
      const result = await tx`
        UPDATE public.delivery_openers SET ${tx(openerColumns(decision.set, row.now))}
         WHERE delivery_id = ${row.delivery_id} AND status = ${decision.expect.status} AND attempts = ${decision.expect.attempts}`;
      expired += result.count;
    }
    return expired;
  });
}
