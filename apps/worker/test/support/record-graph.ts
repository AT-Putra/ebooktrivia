// `node --import ./test/support/record-graph.ts ...`: records every module URL the process
// resolves and every process.env name it reads, appending one line per new entry to the file
// named by RECORD_GRAPH_FILE ("m <url>" / "e <name>"), so the record survives a SIGKILL. The
// variable is removed before the program starts (the internal process refuses unknown names).
import { appendFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const file = process.env["RECORD_GRAPH_FILE"];
if (file === undefined) throw new Error("RECORD_GRAPH_FILE is required");
delete process.env["RECORD_GRAPH_FILE"];
writeFileSync(file, "");
const seen = new Set<string>();
const record = (line: string): void => {
  if (seen.has(line)) return;
  seen.add(line);
  appendFileSync(file, `${line}\n`);
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    record(`m ${result.url}`);
    return result;
  },
});

const env = process.env;
process.env = new Proxy(env, {
  get(target, key, receiver) {
    if (typeof key === "string") record(`e ${key}`);
    return Reflect.get(target, key, receiver) as unknown;
  },
});
