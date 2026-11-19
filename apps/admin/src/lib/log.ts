// Structured JSON logs of the admin app. PII never reaches a log line by construction: an event
// carries only an event name and allowlisted fields of primitive type (ids, enums, counts), and an
// error is reduced to its name and code. Free text (`detail`, Better Auth's log messages) is
// masked first: e-mail addresses, digit runs (phone numbers, codes) and token-like strings are
// replaced, and the text is cut to 200 characters. Error messages and driver details (which can
// quote parameters, e.g. "Key (email)=(...)" or "Failing row contains (...)") are never logged.
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
type Level = "info" | "warn" | "error";

/** Field names that may be logged. Anything else is dropped (and noted). */
const ALLOWED_FIELDS = new Set(["userId", "sessionId", "requestId", "action", "reason", "outcome", "count", "status", "path", "method", "kind", "detail"]);

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const TOKEN = /[A-Za-z0-9_+/=.-]{16,}/g;
const DIGITS = /\+?\d(?:[ .-]?\d){5,}/g;

/** Free text with e-mail addresses, token-like strings and digit runs masked, cut to 200 characters. */
export function maskText(text: string): string {
  return text
    .slice(0, 2000)
    .replace(EMAIL, "[email]")
    .replace(TOKEN, (run) => (/\d/.test(run) || /[A-Z]/.test(run) ? "[token]" : run))
    .replace(DIGITS, "[number]")
    .slice(0, 200);
}

function errorSummary(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as { code?: unknown }).code;
  return { errorType: error.name, ...(typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? { errorCode: code } : {}) };
}

export function formatLogLine(level: Level, event: string, fields: LogFields = {}, error?: unknown): string {
  const kept: Record<string, string | number | boolean | null> = {};
  const dropped: string[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) dropped.push(key);
    else if (typeof val === "string") kept[key] = key === "detail" ? maskText(val) : val.slice(0, 200);
    else kept[key] = val;
  }
  return JSON.stringify({
    level,
    role: "admin",
    event: /^[a-z0-9_.]{1,64}$/.test(event) ? event : "invalid_event_name",
    ...kept,
    ...(dropped.length > 0 ? { droppedFields: dropped.length } : {}),
    ...(error === undefined ? {} : errorSummary(error)),
  });
}

export function logEvent(level: Level, event: string, fields?: LogFields, error?: unknown): void {
  const line = `${formatLogLine(level, event, fields, error)}\n`;
  if (level === "info") process.stdout.write(line);
  else process.stderr.write(line);
}

/** Better Auth's `logger.log`: its message (masked) as `detail`; extra arguments are dropped. */
export function betterAuthLog(level: "debug" | "info" | "warn" | "error", message: string): void {
  if (level === "debug") return;
  logEvent(level, "better_auth.log", { detail: message });
}

/** Better Auth's `onAPIError.onError`: the error's type and code only. */
export function betterAuthApiError(error: unknown): void {
  logEvent("error", "better_auth.api_error", {}, error);
}
