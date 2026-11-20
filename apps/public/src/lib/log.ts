// Structured JSON logs of the public app (same rules as apps/admin lib/log.ts). PII never reaches a
// log line by construction: an event carries only an event name and allowlisted fields of primitive
// type (ids, enums, counts); the buyer's name, phone and e-mail are never a field, and free text
// (`detail`) is masked (e-mail addresses, digit runs such as phone numbers, token-like strings). An
// error is reduced to its name and code: error messages and driver details (which can quote
// parameters) and anything of the Midtrans server key are never logged.
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
export type Level = "info" | "warn" | "error";

const ALLOWED_FIELDS = new Set(["requestId", "route", "lpKey", "orderId", "attempt", "outcome", "reason", "status", "count", "kind", "code", "ms", "detail"]);

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const TOKEN = /[A-Za-z0-9_+/=.-]{16,}/g;
const DIGITS = /\+?\d(?:[ .-]?\d){5,}/g;

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
  let dropped = 0;
  for (const [key, val] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) dropped++;
    else if (typeof val === "string") kept[key] = key === "detail" ? maskText(val) : val.slice(0, 200);
    else kept[key] = val;
  }
  return JSON.stringify({
    level,
    role: "public",
    event: /^[a-z0-9_.]{1,64}$/.test(event) ? event : "invalid_event_name",
    ...kept,
    ...(dropped > 0 ? { droppedFields: dropped } : {}),
    ...(error === undefined ? {} : errorSummary(error)),
  });
}

export type Logger = (level: Level, event: string, fields?: LogFields, error?: unknown) => void;

export const logEvent: Logger = (level, event, fields, error) => {
  const line = `${formatLogLine(level, event, fields, error)}\n`;
  if (level === "info") process.stdout.write(line);
  else process.stderr.write(line);
};
