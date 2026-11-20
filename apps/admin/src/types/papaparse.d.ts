// The part of papaparse 5.7.0's API the question import uses (lib/settings/trivia-import.ts).
// papaparse ships no types and @types/papaparse is not a dependency of this repo; this declares
// only the synchronous string parse with array rows, whole or row by row (`step`).
declare module "papaparse" {
  export interface ParseError {
    readonly type: string;
    readonly code: string;
    readonly message: string;
    /** Index of the row (record) the error is in, when known. */
    readonly row?: number;
  }

  export interface ParseResult {
    readonly data: string[][];
    readonly errors: readonly ParseError[];
    readonly meta: { readonly delimiter: string; readonly linebreak: string; readonly truncated: boolean };
  }

  export interface ParseConfig {
    readonly header?: false;
    readonly dynamicTyping?: false;
    readonly skipEmptyLines?: boolean | "greedy";
    readonly delimiter?: string;
    readonly delimitersToGuess?: readonly string[];
    readonly newline?: string;
    readonly preview?: number;
    /** Called once per record; the result then holds only that record. */
    readonly step?: (result: { readonly data: string[]; readonly errors: readonly ParseError[] }, parser: { abort(): void }) => void;
  }

  const Papa: { parse(input: string, config: ParseConfig): ParseResult };
  export default Papa;
}
