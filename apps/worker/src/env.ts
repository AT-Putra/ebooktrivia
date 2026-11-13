// Strict environment parsing shared by both roles. Every value is validated at startup and a bad
// one stops the process (fail fast). Error messages name the variable, never its value: several
// of them are credentials.

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const NODE_ENVS = ["production", "development", "test"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The value, or undefined when unset or empty. */
export function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}

export function oneOf<T extends string>(env: Env, name: string, values: readonly T[], fallback: T): T {
  const value = optional(env, name) ?? fallback;
  if (!(values as readonly string[]).includes(value)) throw new ConfigError(`${name} must be one of ${values.join(", ")}`);
  return value as T;
}

export function bool(env: Env, name: string): boolean {
  const value = optional(env, name);
  if (value === undefined || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new ConfigError(`${name} must be true, false, 1 or 0`);
}

export function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = optional(env, name);
  if (value === undefined) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer in ${String(min)}..${String(max)}`);
  }
  return n;
}

/** A postgres:// URL. The message never includes the value (it carries the password). */
export function postgresUrl(env: Env, name: string): string {
  const value = required(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a postgres:// or postgresql:// URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError(`${name} must be a postgres:// or postgresql:// URL`);
  }
  return value;
}

/**
 * NODE_ENV is required: the production guards (dev-only flags, failpoints) key off it, so an unset
 * value must stop the process rather than default to development (security review US-013 #2).
 */
export function nodeEnv(env: Env): NodeEnv {
  required(env, "NODE_ENV");
  return oneOf(env, "NODE_ENV", NODE_ENVS, "production");
}
export const logLevel = (env: Env): LogLevel => oneOf(env, "LOG_LEVEL", LOG_LEVELS, "info");
