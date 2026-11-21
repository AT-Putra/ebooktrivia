// The drizzle migration journal (migrations/meta/_journal.json): the migrator applies the entries in order and
// skips one whose `when` is not newer than the last applied migration's, so a rebased or hand-numbered
// migration with an older `when` would silently never run on an existing database. Every `when` must be
// strictly newer than the one before, every entry must have its SQL file and snapshot, and no tag repeats.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("migration journal", () => {
  it("has strictly increasing `when` values", () => {
    const whens = journal.entries.map((e) => e.when);
    for (let i = 1; i < whens.length; i++) expect(whens[i], journal.entries[i]?.tag).toBeGreaterThan(whens[i - 1] ?? 0);
  });

  it("numbers its entries 0..n-1 with distinct tags, each with its SQL file", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_e, i) => i));
    expect(new Set(journal.entries.map((e) => e.tag)).size).toBe(journal.entries.length);
    for (const entry of journal.entries) expect(existsSync(join(migrations, `${entry.tag}.sql`)), entry.tag).toBe(true);
  });
});
