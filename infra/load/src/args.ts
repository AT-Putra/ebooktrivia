// Numeric flags of the load tools: a typo must stop the tool, not become NaN (a NaN rate would settle nothing, a NaN timeout would wait forever).

/** A finite number greater than zero; `integer` also demands a whole number. Throws a message naming the flag. */
export function positiveNumber(name: string, raw: string | undefined, options: { readonly integer?: boolean } = {}): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (options.integer === true && !Number.isInteger(value))) {
    throw new Error(`--${name} must be a${options.integer === true ? " whole" : ""} number greater than zero (got ${JSON.stringify(raw ?? null)})`);
  }
  return value;
}
