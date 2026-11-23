// Numeric flags of the load tools: a typo must stop the tool, not become NaN (a NaN rate would settle nothing, a NaN timeout would wait forever).

/** A finite number greater than zero; `integer` also demands a whole number. Throws a message naming the flag. */
export function positiveNumber(name: string, raw: string | undefined, options: { readonly integer?: boolean } = {}): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (options.integer === true && !Number.isInteger(value))) {
    throw new Error(`--${name} must be a${options.integer === true ? " whole" : ""} number greater than zero (got ${JSON.stringify(raw ?? null)})`);
  }
  return value;
}

/** A whole number from `min` to `max` (inclusive); a typo or an out-of-range value stops the tool. */
export function wholeNumber(name: string, raw: string | undefined, min: number, max: number): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${String(min)} to ${String(max)}`);
  return value;
}

export interface DemoArgs {
  readonly programSlug: string;
  readonly buyers: number;
  /** undefined: the tool draws one and prints it, so the run can be planned again. */
  readonly seed: number | undefined;
  readonly out: string;
  readonly acceptProgramLock: boolean;
}

/** The flags of `seed.ts demo` (programs.slug is lower-case words joined by single hyphens). */
export function demoArgs(values: {
  readonly "program-slug"?: string | undefined;
  readonly buyers?: string | undefined;
  readonly seed?: string | undefined;
  readonly out?: string | undefined;
  readonly "accept-program-lock"?: boolean | undefined;
}): DemoArgs {
  const slug = values["program-slug"];
  if (slug === undefined || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error("--program-slug is the slug of an existing published program (lower-case letters, digits and single hyphens)");
  if (values.out === undefined || values.out.trim() === "") throw new Error("--out is the file the run's plan and login links are written to");
  return {
    programSlug: slug,
    buyers: wholeNumber("buyers", values.buyers ?? "30", 1, 200),
    seed: values.seed === undefined ? undefined : wholeNumber("seed", values.seed, 0, 4_294_967_295),
    out: values.out,
    acceptProgramLock: values["accept-program-lock"] === true,
  };
}
