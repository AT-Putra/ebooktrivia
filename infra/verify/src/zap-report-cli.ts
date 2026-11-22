// node infra/verify/src/zap-report-cli.ts <rules.tsv> <report.json>...: the ZAP gate of zap-report.ts over each report.
// Exit 0 when no report has a failure, 1 on any failure, 2 when a report or the rules file cannot be read.
import { readFileSync } from "node:fs";
import { formatVerdict, judge, parseReport, parseRules } from "./zap-report.ts";

const [rulesPath, ...reports] = process.argv.slice(2);
if (rulesPath === undefined || reports.length === 0) {
  process.stderr.write("usage: node infra/verify/src/zap-report-cli.ts <rules.tsv> <report.json>...\n");
  process.exit(2);
}
let failed = false;
try {
  const rules = parseRules(readFileSync(rulesPath, "utf8"));
  for (const path of reports) {
    const verdict = judge(parseReport(JSON.parse(readFileSync(path, "utf8"))), rules);
    process.stdout.write(`### ${path}\n${formatVerdict(verdict)}`);
    if (verdict.failures.length > 0) failed = true;
  }
} catch (error) {
  process.stderr.write(`zap-report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
process.stdout.write(failed ? "zap-report: FAIL (a High alert, or a rule marked FAIL)\n" : "zap-report: no High alert\n");
process.exit(failed ? 1 : 0);
