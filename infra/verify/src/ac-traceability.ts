// The traceability checker (US-032, plan §8 item 2: "100 % of ACs mapped in docs/ac-traceability.md"): it parses the table of
// docs/ac-traceability.md and fails when an acceptance criterion of the spec is missing, when a cited test file does not exist,
// when a cited test title is not a test of that file, or when a "staging" reference names a go-live item that does not exist.
//
// Table (one row per AC):   | AC-S1 | requirement | US-017, US-019 | evidence | staging |
//   evidence  `;`-separated citations. A citation is a backticked repository path, optionally followed by a double-quoted
//             TITLE that must be (a substring of) the title of an it / test / describe of that file:
//               `apps/public/test/webhook.int.test.ts` "forged notifications (AC-S6)"
//             A path without a title (a script, a runbook, a directory, a whole test file) must exist. The cell may start with
//             the word `staging-pending`: the AC cannot be fully verified before the staging VM exists; the row then must name
//             at least one go-live item.
//   staging   `-`, or `GL-nn` ids of docs/go-live.md (the exact staging step); every id must exist there.
// The AC ids of the spec are fixed below (63 criteria: S1-S10, D1-D8, T1-T8, Q1-Q15, A1-A10, P1-P12); when the spec file is
// available (it lives in .omc/, outside the repository) the test also compares the ids it holds with this list.
export const AC_COUNTS = { S: 10, D: 8, T: 8, Q: 15, A: 10, P: 12 } as const;

export const AC_IDS: readonly string[] = Object.entries(AC_COUNTS).flatMap(([kind, count]) => Array.from({ length: count }, (_, i) => `AC-${kind}${String(i + 1)}`));

/** The ids the spec file lists as acceptance criteria (`- [ ] AC-S1: ...`, also `AC-S10 (Midtrans mode, R29)`). */
export function specIds(spec: string): string[] {
  return [...spec.matchAll(/^- \[[ x]\] (AC-[SDTQAP]\d+)\b/gm)].map((m) => m[1] ?? "");
}

export interface Row {
  readonly id: string;
  readonly requirement: string;
  readonly story: string;
  readonly evidence: string;
  readonly staging: string;
  readonly line: number;
}

/** Table rows whose first cell is an AC id. */
export function parseRows(doc: string): Row[] {
  const rows: Row[] = [];
  for (const [index, line] of doc.split(/\r?\n/).entries()) {
    if (!/^\| AC-[SDTQAP]\d+ \|/.test(line)) continue;
    const cells = line
      .replace(/^\|\s*/, "")
      .replace(/\s*\|\s*$/, "")
      .split(" | ")
      .map((c) => c.trim());
    rows.push({ id: cells[0] ?? "", requirement: cells[1] ?? "", story: cells[2] ?? "", evidence: cells[3] ?? "", staging: cells[4] ?? "", line: index + 1 });
  }
  return rows;
}

export interface Citation {
  readonly path: string;
  readonly title?: string;
}

/** The citations of an evidence cell, in order. */
export function citations(evidence: string): Citation[] {
  return [...evidence.matchAll(/`([^`]+)`(?:\s+"([^"]+)")?/g)].map((m) => (m[2] === undefined ? { path: m[1] ?? "" } : { path: m[1] ?? "", title: m[2] }));
}

export interface TestCall {
  readonly title: string;
  /** `.skip`, `.todo`, `.fails` or `.only`: the test does not run, or the others do not, so it proves nothing. */
  readonly disabled: boolean;
}

/** Modifiers after which a test is not evidence: skipped, a to-do, expected to fail, or `.only` (which silences its neighbours). */
const DISABLING = new Set(["skip", "todo", "fails", "only"]);

/**
 * The it / test / describe calls of a test file with their titles: the first string literal after each call, on its line or the next.
 * `it.each(...)`, `it.skipIf(...)` and the like (whose first argument list is not the title) yield no title.
 */
export function testCalls(source: string): TestCall[] {
  const lines = source.split(/\r?\n/);
  const calls: TestCall[] = [];
  for (const [index, line] of lines.entries()) {
    // A call starts its line (after the indentation): a mention in a comment or inside a string is not a test.
    const call = /^\s*(?:it|test|describe)((?:\.\w+)*)\s*\(/.exec(line);
    if (call === null) continue;
    const modifiers = (call[1] ?? "").split(".").filter((m) => m !== "");
    // A modifier with an argument list of its own (`.each(rows)`, `.skipIf(cond)`) puts the title in a second call: not extracted here.
    if (modifiers.some((m) => ["each", "for", "skipIf", "runIf", "todoIf"].includes(m))) continue;
    const rest = `${line.slice(call[0].length)} ${lines[index + 1] ?? ""}`.trim();
    const literal = /^(["'`])((?:\\.|(?!\1).)*)\1/.exec(rest);
    if (literal?.[2] !== undefined) calls.push({ title: literal[2], disabled: modifiers.some((m) => DISABLING.has(m)) });
  }
  return calls;
}

/** The titles of the tests that run (not skipped, not to-do, not expected to fail, not `.only`). */
export const testTitles = (source: string): string[] => testCalls(source).filter((c) => !c.disabled).map((c) => c.title);

export interface Repo {
  exists(path: string): boolean;
  read(path: string): string;
}

export interface Inputs {
  readonly doc: string;
  readonly goLive: string;
  readonly ids: readonly string[];
  readonly repo: Repo;
}

export interface Summary {
  readonly mapped: number;
  readonly stagingPending: number;
  readonly withStagingStep: number;
  readonly citations: number;
}

/** The `GL-nn` ids of go-live.md (checklist items). */
export const goLiveIds = (goLive: string): string[] => [...goLive.matchAll(/^- \[[ x]\] \*\*(GL-\d+)\*\*/gm)].map((m) => m[1] ?? "");

/** Problems of go-live.md itself: duplicate ids, an item without an owner or a verify step. */
export function checkGoLive(goLive: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const line of goLive.split(/\r?\n/)) {
    const item = /^- \[[ x]\] \*\*(GL-\d+)\*\*/.exec(line);
    if (item === null) continue;
    const id = item[1] ?? "";
    if (seen.has(id)) problems.push(`go-live: ${id} appears twice`);
    seen.add(id);
    if (!/ Owner: (Owner|operator)/.test(line)) problems.push(`go-live: ${id} has no "Owner: Owner|operator"`);
    if (!/ Verify: \S/.test(line)) problems.push(`go-live: ${id} has no "Verify:" step`);
  }
  if (seen.size === 0) problems.push("go-live: no checklist item found");
  return problems;
}

export function checkTraceability({ doc, goLive, ids, repo }: Inputs): { problems: string[]; summary: Summary } {
  const problems: string[] = [];
  const rows = parseRows(doc);
  const known = new Set(goLiveIds(goLive));
  const byId = new Map<string, Row>();
  for (const row of rows) {
    if (byId.has(row.id)) problems.push(`${row.id}: listed twice (line ${String(row.line)})`);
    byId.set(row.id, row);
    if (!ids.includes(row.id)) problems.push(`${row.id}: not an acceptance criterion of the spec (line ${String(row.line)})`);
  }
  let citationCount = 0;
  let stagingPending = 0;
  let withStagingStep = 0;
  const titleCache = new Map<string, TestCall[] | null>();
  const titlesOf = (path: string): TestCall[] | null => {
    if (!titleCache.has(path)) titleCache.set(path, repo.exists(path) ? testCalls(repo.read(path)) : null);
    return titleCache.get(path) ?? null;
  };
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) {
      problems.push(`${id}: missing from the traceability table`);
      continue;
    }
    if (!/^US-\d{3}\b/.test(row.story)) problems.push(`${id}: no delivering story (US-nnn) in the Story column`);
    const pending = row.evidence.startsWith("staging-pending");
    const cites = citations(row.evidence);
    if (!pending && cites.length === 0) problems.push(`${id}: no evidence (a cited test, spec, script or runbook, or "staging-pending")`);
    for (const cite of cites) {
      citationCount++;
      if (!repo.exists(cite.path)) {
        problems.push(`${id}: cited file does not exist: ${cite.path}`);
        continue;
      }
      if (cite.title === undefined) continue;
      const titles = titlesOf(cite.path);
      if (titles === null || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(cite.path)) problems.push(`${id}: ${cite.path} is not a test file, so it cannot carry the title "${cite.title}"`);
      else {
        const matching = titles.filter((t) => t.title.includes(cite.title ?? ""));
        if (matching.length === 0) problems.push(`${id}: no test titled "${cite.title}" in ${cite.path}`);
        else if (matching.every((t) => t.disabled)) problems.push(`${id}: the test titled "${cite.title}" in ${cite.path} is skipped, a to-do, expected to fail or .only: it proves nothing`);
      }
    }
    const steps = [...row.staging.matchAll(/GL-\d+/g)].map((m) => m[0]);
    if (row.staging !== "-" && steps.length === 0) problems.push(`${id}: the Staging column is "-" or GL-nn ids`);
    for (const step of steps) if (!known.has(step)) problems.push(`${id}: ${step} is not an item of docs/go-live.md`);
    if (pending && steps.length === 0) problems.push(`${id}: staging-pending without the exact staging step (GL-nn)`);
    if (pending) stagingPending++;
    if (steps.length > 0) withStagingStep++;
  }
  return { problems, summary: { mapped: ids.filter((id) => byId.has(id)).length, stagingPending, withStagingStep, citations: citationCount } };
}
