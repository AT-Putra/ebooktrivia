// Audit middleware (AC-A2, plan M5a.3): every admin mutation runs through `withAudit`, which opens
// the transaction, hands it to the mutation and inserts the mutation's audit_log rows in that SAME
// transaction before committing. If the audit insert fails, the change rolls back, and the reverse.
// A mutation that records no audit entry is refused.
//
// What is stored (governance.ts audit_log): each changed field is classified by the caller:
//   value   non-PII: before / after values, e.g. {"role": {"before": "staff", "after": "owner"}};
//   secret  {"set": true | false}, never the value;
//   pii     no value at all: only a reference in pii_refs, e.g. "admin_user:<id>.email changed".
// A field in `before` / `after` that the caller did not classify throws, so a new column cannot
// slip its value into the log unclassified. `facts` carry non-PII context (ids, enums, counts).
//
// Mutations run only inside a mutation scope: a POST server action or a non-GET route handler
// (lib/next/actions.ts, lib/next/route.ts) or the VM CLI. Page renders and GET handlers have no
// scope, so a GET request cannot reach `withAudit` (plan M5a.2: no state change on GET).
//
// Accepted deviations (code review US-016 CM3). Better Auth writes on its own connection, so these
// commit BEFORE their audit row and cannot share its transaction:
//   - storing the TOTP secret (enableTwoFactor, enrollment step 1),
//   - turning TOTP on and replacing the session (verifyTOTP, enrollment step 2),
//   - deleting the session at sign-out (signOut),
//   - creating a session at sign-in (its session_state + audit row follow).
// For the first three, lib/auth/service.ts writes a `*_requested` row before the call, so a crash in
// between leaves the request on record; the completion row follows the call. A session created
// without its row is unusable (session_state is missing), so sign-in fails closed. Settings changes
// (everything written by our own SQL) always go through withAudit.
import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";

export type FieldKind = "value" | "secret" | "pii";
export type AuditActor = { readonly kind: "admin"; readonly userId: string } | { readonly kind: "system" } | { readonly kind: "cli" };
export type Fact = string | number | boolean | null;

export interface AuditChange {
  /** dotted lower-case, e.g. "admin_user.create" */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly fields?: Readonly<Record<string, FieldKind>>;
  /** null / absent: the entity did not exist before (create). */
  readonly before?: Readonly<Record<string, unknown>> | null;
  /** null / absent: the entity does not exist after (delete). */
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly facts?: Readonly<Record<string, Fact>>;
  /** Overrides the scope's actor, e.g. the admin who just signed in. */
  readonly actor?: AuditActor;
}

export class AuditClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditClassificationError";
  }
}

const ACTION = /^[a-z_]+(\.[a-z_]+)+$/;
const ENTITY = /^[a-z_]+$/;

function jsonValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(jsonValue(a)) === JSON.stringify(jsonValue(b));
const isBlank = (v: unknown): boolean => v === undefined || v === null || v === "";

/** The audit_log `changes` and `pii_refs` of one change (pure; throws on unclassified fields). */
export function describeChange(change: AuditChange): { changes: Record<string, unknown>; piiRefs: string[] } {
  if (!ACTION.test(change.action)) throw new AuditClassificationError(`bad audit action ${change.action}`);
  if (!ENTITY.test(change.entityType)) throw new AuditClassificationError(`bad audit entity type ${change.entityType}`);
  const fields = change.fields ?? {};
  const before = change.before ?? null;
  const after = change.after ?? null;
  for (const record of [before, after]) {
    for (const key of Object.keys(record ?? {})) {
      if (!Object.hasOwn(fields, key)) throw new AuditClassificationError(`field ${change.entityType}.${key} is not classified for the audit log`);
    }
  }
  const changes: Record<string, unknown> = {};
  const piiRefs: string[] = [];
  for (const [field, kind] of Object.entries(fields)) {
    const b = before?.[field];
    const a = after?.[field];
    if (before !== null && after !== null && same(b, a)) continue;
    if (isBlank(b) && isBlank(a)) continue;
    if (kind === "value") {
      changes[field] = { ...(before === null ? {} : { before: jsonValue(b) }), ...(after === null ? {} : { after: jsonValue(a) }) };
    } else if (kind === "secret") {
      changes[field] = { set: !isBlank(a) };
    } else {
      const verb = isBlank(b) ? "set" : isBlank(a) ? "cleared" : "changed";
      piiRefs.push(`${change.entityType}:${change.entityId ?? "new"}.${field} ${verb}`);
    }
  }
  for (const [key, fact] of Object.entries(change.facts ?? {})) {
    if (Object.hasOwn(fields, key)) throw new AuditClassificationError(`fact ${key} collides with a field`);
    changes[key] = fact;
  }
  return { changes, piiRefs };
}

export interface MutationScope {
  readonly actor: AuditActor;
  readonly requestId: string | null;
  readonly ip: string | null;
}

const scopes = new AsyncLocalStorage<MutationScope>();

export function runMutation<T>(scope: MutationScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn);
}

export function currentMutationScope(): MutationScope | undefined {
  return scopes.getStore();
}

export class NoMutationScopeError extends Error {
  constructor() {
    super("mutations run only in a POST server action, a non-GET route handler or the CLI");
    this.name = "NoMutationScopeError";
  }
}

export type Tx = postgres.TransactionSql;
export type AuditRecorder = (change: AuditChange) => void;

/** Inserts one audit row on `tx` (the caller's transaction). */
export async function insertAudit(tx: Tx | postgres.Sql, scope: MutationScope, change: AuditChange): Promise<void> {
  const { changes, piiRefs } = describeChange(change);
  const actor = change.actor ?? scope.actor;
  await tx`
    INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
    VALUES (${actor.kind}, ${actor.kind === "admin" ? actor.userId : null}, ${change.action}, ${change.entityType},
            ${change.entityId}, ${JSON.stringify(changes)}::text::jsonb, ${piiRefs}, ${scope.requestId}, ${scope.ip})`;
}

/**
 * Runs `mutate` in one transaction and writes the audit entries it records, in that transaction.
 * Throws NoMutationScopeError outside a mutation scope.
 */
export async function withAudit<T>(sql: postgres.Sql, mutate: (tx: Tx, audit: AuditRecorder) => Promise<T>): Promise<T> {
  const scope = currentMutationScope();
  if (scope === undefined) throw new NoMutationScopeError();
  return sql.begin(async (tx) => {
    const entries: AuditChange[] = [];
    const result = await mutate(tx, (change) => {
      describeChange(change);
      entries.push(change);
    });
    if (entries.length === 0) throw new Error("a mutation must record at least one audit entry");
    for (const entry of entries) await insertAudit(tx, scope, entry);
    return result;
  });
}
