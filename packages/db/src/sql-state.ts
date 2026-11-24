// The SQLSTATE of a PostgreSQL error, read by SHAPE, never by `instanceof` alone. A Next.js app bundles a copy of postgres.js per
// bundle (pages, routes, the proxy, server actions), and a pool one bundle built (the public app's process-wide runtime, the
// admin's) throws its own copy's PostgresError, so `error instanceof postgres.PostgresError` in another bundle is false and a
// database refusal (a trigger's ETxxx, a deadlock's 40P01) would be treated as an unexpected failure (US-033, 2026-11-24).
import postgres from "postgres";

/**
 * The SQLSTATE `code` of a PostgreSQL error from ANY copy of postgres.js, else undefined. A PostgresError carries the server's
 * `severity` and a five-character SQLSTATE `code`; a Node system error (EPIPE, ECONNRESET) has no severity, and a plain object
 * is not an Error.
 */
export function sqlState(error: unknown): string | undefined {
  if (error instanceof postgres.PostgresError) return error.code;
  if (!(error instanceof Error)) return undefined;
  const { code, severity } = error as { readonly code?: unknown; readonly severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string" ? code : undefined;
}
