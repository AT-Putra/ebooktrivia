// Structured JSON logs (pino). Values under credential-like or PII keys are replaced at ANY depth
// before a line is written: authorization, x-api-key, cookies, every `headers` object (a
// PreparedRequest's headers carry access tokens: log its `redacted` form only), sealed material,
// secret fields, phone / email / chat ids, URLs (push URLs and postbacks carry tokens) and whole
// payloads. Errors are reduced to type, message, code and stack, so driver errors never carry query
// parameters (phone numbers, tokens) into the log.
import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./env.ts";

export type { Logger };

const REDACTED = "[redacted]";
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "headers",
  "sealed",
  "secret",
  "token",
  "password",
  "accesstoken",
  "access_token",
  "access-token",
  "apikey",
  "api_key",
  // Security review US-013 #5a: PII and token-carrying URLs.
  "phone",
  "email",
  "wa_chat_id",
  "msisdn",
  "to",
  "url",
  "pushurl",
  "dsn",
  "payload",
]);
const MAX_DEPTH = 8;

function redact(value: unknown, depth: number): unknown {
  if (typeof value !== "object" || value === null || value instanceof Error || ArrayBuffer.isView(value)) return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.map((item: unknown) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1)]),
  );
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { code?: unknown }).code;
  return { type: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}), stack: error.stack };
}

export function createLogger(options: { readonly level: LogLevel; readonly role: "worker" | "internal" }, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { role: options.role, pid: process.pid },
      serializers: { err: serializeError },
      formatters: { log: (object) => redact(object, 0) as Record<string, unknown> },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
