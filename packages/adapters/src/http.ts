// The HTTP port every adapter depends on. createSafeFetch() satisfies it in production; tests pass
// an in-process stub (e.g. the Hono app of infra/midtrans-stub) so no socket is opened.

export interface HttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** At most `maxBytes` of the body, the rest discarded (SafeResponse has it; stubs may not). */
  textPrefix?(maxBytes: number): Promise<string>;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array;
  /** The caller's time budget; safe-fetch combines it with its own timeout. */
  readonly signal?: AbortSignal;
}

export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A required, non-empty string field. */
export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
