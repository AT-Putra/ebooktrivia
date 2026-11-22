// Runs the header policy of security-headers.ts over the dumps infra/verify/local/security-headers.sh collected:
//   node infra/verify/src/security-headers-cli.ts <dir>
// <dir>/index.tsv lists one probe per line: host kind, label, expected status (* = any), dump file (a `curl -D -`
// output) and, optionally, the route's own Referrer-Policy. A label ending in "#2" is a second load of the page with
// the same label: its CSP nonce must differ. Prints PASS / FAIL per probe and exits 1 on any failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Answer, checkFreshNonce, checkProbe, type HostKind, parseHeaderDump } from "./security-headers.ts";

const HOSTS: ReadonlySet<string> = new Set(["admin", "play", "order", "api", "sdk", "lp"]);
const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("usage: node infra/verify/src/security-headers-cli.ts <dir>\n");
  process.exit(2);
}
const seen = new Map<string, Answer>();
let failed = 0;
let probes = 0;
for (const line of readFileSync(join(dir, "index.tsv"), "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const [host = "", label = "", expected = "", file = "", referrer = ""] = line.split("\t");
  if (!HOSTS.has(host)) throw new Error(`index.tsv: unknown host kind ${host}`);
  const answer = parseHeaderDump(readFileSync(join(dir, file), "utf8"));
  const problems = checkProbe({
    host: host as HostKind,
    label,
    expectedStatus: expected === "*" ? null : Number(expected),
    ...(referrer === "" ? {} : { expectedReferrer: referrer }),
    response: answer,
  });
  if (label.endsWith("#2")) {
    const first = seen.get(`${host} ${label.slice(0, -2)}`);
    problems.push(...(first === undefined ? ["no first load to compare the nonce with"] : checkFreshNonce(first, answer)));
  }
  seen.set(`${host} ${label}`, answer);
  probes++;
  if (problems.length === 0) process.stdout.write(`PASS  ${host} ${label}\n`);
  else {
    failed++;
    for (const problem of problems) process.stdout.write(`FAIL  ${host} ${label}: ${problem}\n`);
  }
}
process.stdout.write(failed === 0 ? `security-headers: ${String(probes)} responses, all pass\n` : `security-headers: ${String(failed)} of ${String(probes)} responses FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
