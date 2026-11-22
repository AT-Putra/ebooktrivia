// The traceability checker (ac-traceability.ts) on synthetic documents, each rule broken in turn, and then on the REAL
// docs/ac-traceability.md and docs/go-live.md against the real repository: the plan's "100 % of ACs mapped" (§8 item 2).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AC_IDS, type Repo, checkGoLive, checkTraceability, citations, goLiveIds, parseRows, specIds, testTitles } from "./ac-traceability.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const realRepo: Repo = { exists: (p) => existsSync(join(REPO, p)), read: (p) => readFileSync(join(REPO, p), "utf8") };

// ---------------------------------------------------------------------------------------------
// synthetic inputs

const IDS = ["AC-S1", "AC-S2", "AC-S3"] as const;
const FILES: Record<string, string> = {
  "a/one.test.ts": 'describe("group", () => {\n  it("does the first thing (AC-S1)", () => {});\n  it(\n    "wraps its title on the next line",\n    () => {},\n  );\n});\n',
  "a/two.spec.ts": "test('single quotes work', () => {});\ntest.describe(`template title`, () => {});\n",
  "a/notes.md": "# notes\n",
  "a/disabled.test.ts": [
    'it.skip("skipped one", () => {});',
    'it.todo("todo one");',
    'it.fails("fails one", () => {});',
    'test.only("only one", () => {});',
    'describe.skip("skipped group", () => {});',
    'it("runs fine", () => {});',
    'it.skip("twin", () => {});',
    'it("twin", () => {});',
    'it.each([1, 2])("rows %i", () => {});',
    'it.skipIf(true)("conditional", () => {});',
    "",
  ].join("\n"),
  "a/comment.test.ts": '// it("only in a comment")\nconst note = "it(\\"in a string\\")";\n',
  "scripts/x.sh": "#!/bin/sh\n",
};
const repo: Repo = { exists: (p) => p in FILES, read: (p) => FILES[p] ?? "" };
const GO_LIVE = [
  "- [ ] **GL-01** Do the thing. Owner: operator. Verify: it works. Source: US-1.",
  "- [ ] **GL-02** Do the other thing. Owner: Owner. Verify: it also works. Source: US-2.",
].join("\n");

const row = (id: string, story: string, evidence: string, staging: string): string => `| ${id} | something | ${story} | ${evidence} | ${staging} |`;
const table = (rows: string[]): string => ["| AC | Requirement | Story | Evidence | Staging |", "|---|---|---|---|---|", ...rows].join("\n");
const GOOD = [
  row("AC-S1", "US-001", '`a/one.test.ts` "does the first thing"; `scripts/x.sh`', "-"),
  row("AC-S2", "US-002, US-003", '`a/two.spec.ts` "template title"', "GL-01"),
  row("AC-S3", "US-004", 'staging-pending; `a/one.test.ts` "wraps its title on the next line"', "GL-02"),
];
const check = (rows: string[], overrides: Partial<{ goLive: string; ids: readonly string[] }> = {}) =>
  checkTraceability({ doc: table(rows), goLive: overrides.goLive ?? GO_LIVE, ids: overrides.ids ?? IDS, repo });

describe("parsing", () => {
  it("reads the AC ids of a spec, also the ones with a parenthesis", () => {
    expect(specIds("- [ ] AC-S1: text\n- [x] AC-S10 (Midtrans mode, R29): text\nAC-S99 in prose\n- [ ] AC-P12 (monitoring, R27): x")).toEqual(["AC-S1", "AC-S10", "AC-P12"]);
  });

  it("knows the 63 criteria of the spec", () => {
    expect(AC_IDS).toHaveLength(63);
    expect(new Set(AC_IDS).size).toBe(63);
    expect(AC_IDS[0]).toBe("AC-S1");
    expect(AC_IDS).toContain("AC-Q15");
    expect(AC_IDS).toContain("AC-P12");
  });

  it("splits rows into five cells and ignores every other line", () => {
    const rows = parseRows(`${table(GOOD)}\n\nprose | AC-S1 |`);
    expect(rows.map((r) => r.id)).toEqual(["AC-S1", "AC-S2", "AC-S3"]);
    expect(rows[1]).toMatchObject({ story: "US-002, US-003", staging: "GL-01" });
  });

  it("extracts citations with and without a title", () => {
    expect(citations('`x/y.test.ts` "a title"; `docs/z.md`; plain words')).toEqual([{ path: "x/y.test.ts", title: "a title" }, { path: "docs/z.md" }]);
  });

  it("finds titles in it / test / describe calls on their line or the next, and nowhere else", () => {
    expect(testTitles(FILES["a/one.test.ts"] ?? "")).toEqual(["group", "does the first thing (AC-S1)", "wraps its title on the next line"]);
    expect(testTitles(FILES["a/two.spec.ts"] ?? "")).toEqual(["single quotes work", "template title"]);
    expect(testTitles(FILES["a/comment.test.ts"] ?? "")).toEqual([]);
  });
});

describe("checkTraceability", () => {
  it("passes a complete table and counts it", () => {
    const { problems, summary } = check(GOOD);
    expect(problems).toEqual([]);
    expect(summary).toEqual({ mapped: 3, stagingPending: 1, withStagingStep: 2, citations: 4 });
  });

  it("fails an AC missing from the table, and a row that is not an AC of the spec, and a duplicate", () => {
    expect(check(GOOD.slice(0, 2)).problems).toEqual(["AC-S3: missing from the traceability table"]);
    expect(check([...GOOD, row("AC-S9", "US-001", "`scripts/x.sh`", "-")]).problems).toEqual(["AC-S9: not an acceptance criterion of the spec (line 6)"]);
    expect(check([...GOOD, row("AC-S1", "US-001", "`scripts/x.sh`", "-")]).problems[0]).toMatch(/AC-S1: listed twice/);
  });

  it("fails a cited file that does not exist", () => {
    expect(check([row("AC-S1", "US-001", "`a/nope.test.ts`", "-"), GOOD[1] ?? "", GOOD[2] ?? ""]).problems).toEqual(["AC-S1: cited file does not exist: a/nope.test.ts"]);
  });

  it("fails a title that is not a test of the cited file (also one that only appears in a comment or a string)", () => {
    const wrong = check([row("AC-S1", "US-001", '`a/one.test.ts` "does the second thing"', "-"), GOOD[1] ?? "", GOOD[2] ?? ""]);
    expect(wrong.problems).toEqual(['AC-S1: no test titled "does the second thing" in a/one.test.ts']);
    const comment = check([row("AC-S1", "US-001", '`a/comment.test.ts` "only in a comment"', "-"), GOOD[1] ?? "", GOOD[2] ?? ""]);
    expect(comment.problems).toEqual(['AC-S1: no test titled "only in a comment" in a/comment.test.ts']);
  });

  it("fails a title on a file that is not a test file", () => {
    expect(check([row("AC-S1", "US-001", '`a/notes.md` "notes"', "-"), GOOD[1] ?? "", GOOD[2] ?? ""]).problems).toEqual(['AC-S1: a/notes.md is not a test file, so it cannot carry the title "notes"']);
  });

  // Review item 10: a skipped, to-do, expected-to-fail or .only test passes nothing, so it cannot be evidence.
  it("fails a title that only a skipped, to-do, expected-to-fail or .only test or describe carries, but accepts one that also runs", () => {
    const rest = [GOOD[1] ?? "", GOOD[2] ?? ""];
    for (const title of ["skipped one", "todo one", "fails one", "only one", "skipped group"]) {
      expect(check([row("AC-S1", "US-001", `\`a/disabled.test.ts\` "${title}"`, "-"), ...rest]).problems, title).toEqual([`AC-S1: the test titled "${title}" in a/disabled.test.ts is skipped, a to-do, expected to fail or .only: it proves nothing`]);
    }
    expect(check([row("AC-S1", "US-001", '`a/disabled.test.ts` "runs fine"; `a/disabled.test.ts` "twin"', "-"), ...rest]).problems).toEqual([]);
    // it.each / it.skipIf carry their title in a second call: they cannot be cited at all
    expect(check([row("AC-S1", "US-001", '`a/disabled.test.ts` "rows"', "-"), ...rest]).problems).toEqual(['AC-S1: no test titled "rows" in a/disabled.test.ts']);
  });

  it("lists as titles only the tests that run", () => {
    expect(testTitles(FILES["a/disabled.test.ts"] ?? "")).toEqual(["runs fine", "twin"]);
  });

  it("fails a row without evidence, without a story, with a Staging cell that is neither - nor GL ids, or with an unknown GL id", () => {
    const rest = [GOOD[1] ?? "", GOOD[2] ?? ""];
    expect(check([row("AC-S1", "US-001", "none", "-"), ...rest]).problems[0]).toMatch(/AC-S1: no evidence/);
    expect(check([row("AC-S1", "the team", "`scripts/x.sh`", "-"), ...rest]).problems[0]).toMatch(/AC-S1: no delivering story/);
    expect(check([row("AC-S1", "US-001", "`scripts/x.sh`", "later"), ...rest]).problems[0]).toMatch(/Staging column/);
    expect(check([row("AC-S1", "US-001", "`scripts/x.sh`", "GL-99"), ...rest]).problems).toEqual(["AC-S1: GL-99 is not an item of docs/go-live.md"]);
  });

  it("fails staging-pending without its exact staging step", () => {
    expect(check([GOOD[0] ?? "", GOOD[1] ?? "", row("AC-S3", "US-004", "staging-pending", "-")]).problems).toEqual(["AC-S3: staging-pending without the exact staging step (GL-nn)"]);
  });
});

describe("checkGoLive", () => {
  it("accepts items with an owner and a verify step", () => {
    expect(checkGoLive(GO_LIVE)).toEqual([]);
    expect(goLiveIds(GO_LIVE)).toEqual(["GL-01", "GL-02"]);
  });

  it("fails a duplicate id, a missing owner and a missing verify step", () => {
    expect(checkGoLive(`${GO_LIVE}\n- [ ] **GL-01** Again. Owner: operator. Verify: x.`)).toEqual(["go-live: GL-01 appears twice"]);
    expect(checkGoLive("- [ ] **GL-03** No owner. Verify: x.")).toEqual(['go-live: GL-03 has no "Owner: Owner|operator"']);
    expect(checkGoLive("- [ ] **GL-04** No step. Owner: Owner.")).toEqual(['go-live: GL-04 has no "Verify:" step']);
    expect(checkGoLive("nothing")).toEqual(["go-live: no checklist item found"]);
  });
});

// ---------------------------------------------------------------------------------------------
// the real documents

describe("docs/ac-traceability.md and docs/go-live.md", () => {
  const doc = readFileSync(join(REPO, "docs/ac-traceability.md"), "utf8");
  const goLive = readFileSync(join(REPO, "docs/go-live.md"), "utf8");

  it("maps every one of the 63 acceptance criteria to existing tests, scripts or runbooks, or to a go-live step", () => {
    const { problems, summary } = checkTraceability({ doc, goLive, ids: AC_IDS, repo: realRepo });
    expect(problems).toEqual([]);
    expect(summary.mapped).toBe(63);
  });

  it("has a go-live checklist whose items all carry an owner and a verify step", () => {
    expect(checkGoLive(goLive)).toEqual([]);
    expect(goLiveIds(goLive).length).toBeGreaterThanOrEqual(60);
  });

  it("cites every go-live item of the staging-only work of this story (the k6 runs, the drills, PAID to e-mail)", () => {
    for (const id of ["GL-60", "GL-62", "GL-64", "GL-67", "GL-68"]) expect(goLiveIds(goLive)).toContain(id);
  });

  // The spec lives in .omc/ (not in the repository): compared when AC_SPEC_PATH points at it, or when it sits at the default place.
  const specPath = process.env["AC_SPEC_PATH"] ?? join(REPO, ".omc/specs/deep-interview-ebook-trivia-funnel.md");
  it.skipIf(!existsSync(specPath))("lists exactly the acceptance criteria of the spec file", () => {
    expect(specIds(readFileSync(specPath, "utf8")).sort()).toEqual([...AC_IDS].sort());
  });
});
