// node infra/verify/src/expand-only-cli.ts [--refuse-contract-ok] FILE.sql...   (run through infra/verify/local/expand-only.sh)
// Exit 1 when a migration contracts the schema without a `-- contract-ok: <reason>` line (src/expand-only.ts). With --refuse-contract-ok (the
// deploy job: the files are every migration since the release on the VM, possibly many commits) a contract-ok line does not cover its file.
import { readFileSync } from "node:fs";
import { checkMigration, checkRange } from "./expand-only.ts";

const args = process.argv.slice(2);
const strict = args.includes("--refuse-contract-ok");
const files = args.filter((arg) => !arg.startsWith("--"));
const range = checkRange(
  files.map((name) => ({ name, sql: readFileSync(name, "utf8") })),
  { strict },
);

let failed = 0;
for (const file of files) {
  const check = checkMigration(readFileSync(file, "utf8"));
  if (check.findings.length === 0) {
    process.stdout.write(`ok       ${file}: expands only\n`);
  } else if (check.marked && !range.markedRefused.includes(file)) {
    process.stdout.write(`marked   ${file}: ${String(check.findings.length)} contract statement(s), covered by its contract-ok line\n`);
  } else if (check.marked) {
    failed++;
    process.stderr.write(
      `CONTRACT-OK ${file}: a contract step, covered by its contract-ok line, but a deploy range may not contain one: the release on the VM may still use what it removes. ` +
        "Deploy the release that adds it on its own, or run the deploy workflow with allow_contract_ok after checking that no deployed release uses it\n",
    );
  } else {
    failed++;
    for (const f of check.findings) process.stderr.write(`CONTRACT ${file}:${String(f.line)}: ${f.rule}: ${f.text}\n`);
    process.stderr.write(`         ${file}: a release may only expand the schema; move this to a LATER release, or say why it is safe on a line \`-- contract-ok: <reason>\` (docs/runbooks/deploy.md)\n`);
  }
}
process.stdout.write(`expand-only: ${String(files.length)} migration file(s), ${String(failed)} refused${strict ? " (deploy range: contract-ok lines not accepted)" : ""}\n`);
process.exit(failed === 0 ? 0 : 1);
