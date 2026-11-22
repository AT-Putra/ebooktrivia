// node infra/verify/src/zap-signed-in-cli.ts <admin|play> <domain> <urls.txt>: fails an authenticated ZAP scan that
// did not reach a signed-in-only page (zap-report.ts signedInUrls). Exit 0 signed in, 1 not, 2 bad arguments or file.
import { readFileSync } from "node:fs";
import { type ScanTarget, signedInUrls } from "./zap-report.ts";

const [target, domain, path] = process.argv.slice(2);
if ((target !== "admin" && target !== "play") || domain === undefined || path === undefined) {
  process.stderr.write("usage: node infra/verify/src/zap-signed-in-cli.ts <admin|play> <domain> <urls.txt>\n");
  process.exit(2);
}
let exported: string;
try {
  exported = readFileSync(path, "utf8");
} catch (error) {
  process.stderr.write(`zap-signed-in: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const found = signedInUrls(target satisfies ScanTarget, domain, exported);
if (found.length === 0) {
  process.stdout.write(`zap-signed-in: FAIL the ${target} scan reached no signed-in-only page: it was not authenticated, its report proves nothing\n`);
  process.exit(1);
}
process.stdout.write(`zap-signed-in: the ${target} scan was signed in (${String(found.length)} signed-in-only pages, e.g. ${found[0] ?? ""})\n`);
