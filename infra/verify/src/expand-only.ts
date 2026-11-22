// The expand/contract rule of a deploy (US-015, plan M4.4): a release's migrations only EXPAND the schema, so the previous
// release still runs on it. That is what lets a failed deploy roll the IMAGES back without touching the schema
// (infra/deploy/remote.sh), and what the CI job migration-compat proves by running the previous release's tests on the new
// schema (infra/verify/local/migration-compat.sh).
//
// What a migration may not do in the release that adds it, because the previous release would break:
//   drop or rename a table, column, schema, type, function, view, trigger, policy or sequence; change a column's type;
//   make an existing column NOT NULL; drop a column's DEFAULT (the previous release's INSERT omits the column); add a
//   NOT NULL column without a default (same reason); REVOKE a privilege (the previous release's logins use it); TRUNCATE.
// Those are the CONTRACT step of a LATER release, once nothing deployed uses the thing. A file that really is such a step
// says so on a line of its own, `-- contract-ok: <why the previous release no longer needs it>`, which a reviewer sees.
export interface Finding {
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

export interface MigrationCheck {
  readonly findings: readonly Finding[];
  /** The file carries `-- contract-ok: <reason>`. */
  readonly marked: boolean;
  /** No finding, or every finding is covered by the marker. */
  readonly ok: boolean;
}

const MARKER = /^[ \t]*--[ \t]*contract-ok:[ \t]*(\S.{4,})$/m;

interface Rule {
  readonly rule: string;
  readonly pattern: RegExp;
}

// Applied to one statement at a time, with comments and string literals blanked out.
const RULES: readonly Rule[] = [
  { rule: "drop table", pattern: /\bDROP\s+TABLE\b/i },
  { rule: "drop column", pattern: /\bDROP\s+COLUMN\b/i },
  { rule: "drop schema or type", pattern: /\bDROP\s+(?:SCHEMA|TYPE|DOMAIN)\b/i },
  // `DROP FUNCTION IF EXISTS f; CREATE FUNCTION f ...` to change a signature is a contract step too: the previous release calls f(old signature).
  { rule: "drop a function, view, trigger, policy or sequence", pattern: /\bDROP\s+(?:MATERIALIZED\s+)?(?:FUNCTION|PROCEDURE|AGGREGATE|VIEW|TRIGGER|POLICY|SEQUENCE|RULE)\b/i },
  { rule: "drop a column's default", pattern: /\bALTER\s+COLUMN\s+\S+\s+DROP\s+DEFAULT\b/i },
  { rule: "revoke a privilege", pattern: /\bREVOKE\b/i },
  { rule: "rename", pattern: /\bRENAME\b/i },
  { rule: "change a column's type", pattern: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i },
  { rule: "make an existing column NOT NULL", pattern: /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i },
  { rule: "truncate", pattern: /\bTRUNCATE\b/i },
];

/** The text with comments and the contents of single-quoted strings replaced by spaces (line breaks kept). */
export function blankCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      const length = end === -1 ? rest.length : end;
      out += blank(rest.slice(0, length));
      i += length;
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const length = end === -1 ? rest.length : end + 2;
      out += blank(rest.slice(0, length));
      i += length;
    } else if (rest.startsWith("'")) {
      let j = 1;
      while (j < rest.length && !(rest[j] === "'" && rest[j + 1] !== "'")) j += rest[j] === "'" ? 2 : 1;
      const length = Math.min(j + 1, rest.length);
      out += "'" + blank(rest.slice(1, length - 1)) + (length > 1 ? "'" : "");
      i += length;
    } else {
      out += rest.charAt(0);
      i += 1;
    }
  }
  return out;
}

/** Statements with the line they start on (split on `;`, which no longer occurs in a comment or a string). */
function statements(clean: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  let line = 1;
  let start = 0;
  let startLine = 1;
  for (let i = 0; i <= clean.length; i++) {
    if (clean[i] === "\n") line++;
    if (i === clean.length || clean[i] === ";") {
      const text = clean.slice(start, i);
      if (text.trim() !== "") {
        const lead = text.length - text.trimStart().length;
        result.push({ line: startLine + (text.slice(0, lead).match(/\n/g) ?? []).length, text: text.trim() });
      }
      start = i + 1;
      startLine = line;
    }
  }
  return result;
}

/** `ADD COLUMN ... NOT NULL` with no DEFAULT and no generation expression, clause by clause. */
function notNullWithoutDefault(statement: string): boolean {
  if (!/\bALTER\s+TABLE\b/i.test(statement)) return false;
  const clauses = statement.split(/,(?=\s*ADD\b|\s*ALTER\b|\s*DROP\b)/i);
  return clauses.some((clause) => /\bADD\s+COLUMN\b/i.test(clause) && /\bNOT\s+NULL\b/i.test(clause) && !/\b(?:DEFAULT|GENERATED)\b/i.test(clause));
}

export function checkMigration(sql: string): MigrationCheck {
  const findings: Finding[] = [];
  for (const statement of statements(blankCommentsAndStrings(sql))) {
    const text = statement.text.replace(/\s+/g, " ").slice(0, 140);
    for (const { rule, pattern } of RULES) {
      if (pattern.test(statement.text)) findings.push({ line: statement.line, rule, text });
    }
    if (notNullWithoutDefault(statement.text)) findings.push({ line: statement.line, rule: "add a NOT NULL column without a default", text });
  }
  const marked = MARKER.test(sql);
  return { findings, marked, ok: findings.length === 0 || marked };
}

export interface RangeVerdict {
  /** Files that contract the schema with no contract-ok line. */
  readonly unmarked: readonly string[];
  /** Files whose contract steps a contract-ok line covers, but which a deploy range does not accept (strict, without the explicit allowance). */
  readonly markedRefused: readonly string[];
  /** Files whose contract steps a contract-ok line covers and that are accepted. */
  readonly markedAccepted: readonly string[];
  readonly ok: boolean;
}

/**
 * The migrations a DEPLOY brings: every one added between the release running on the VM and the one being deployed, which can be many commits.
 * A `contract-ok` line promises that the PREVIOUS release no longer needs what the file removes. That is known for a one-step deploy only: across
 * a jump the release on the VM may be older and still use it. So in `strict` mode (the deploy job) a marked file is refused too, unless the
 * operator says so on purpose (`allowContractOk`, the workflow input of the same name); outside a deploy (CI on a change) a marker covers its file.
 */
export function checkRange(files: readonly { name: string; sql: string }[], options: { strict: boolean; allowContractOk?: boolean }): RangeVerdict {
  const unmarked: string[] = [];
  const markedRefused: string[] = [];
  const markedAccepted: string[] = [];
  for (const file of files) {
    const check = checkMigration(file.sql);
    if (check.findings.length === 0) continue;
    if (!check.marked) unmarked.push(file.name);
    else if (options.strict && options.allowContractOk !== true) markedRefused.push(file.name);
    else markedAccepted.push(file.name);
  }
  return { unmarked, markedRefused, markedAccepted, ok: unmarked.length === 0 && markedRefused.length === 0 };
}
