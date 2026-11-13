// The real worker composition (src/worker.ts runWorker: same config loader, loops, sweepers,
// failpoints, signal handling) with TEST ports, for the chaos tests. Production main.ts passes no
// ports yet (US-021 / US-024 / US-025 register them), so this entry adds:
//   - an outbox consumer for topic `test.probe` whose effect is one POST to the counting sink;
//   - the conversion fire port, built on the real adapters: sendConversion over createSafeFetch
//     (the dev flags let it reach the loopback http sink).
// Run: node test/support/worker-harness.ts, with the worker env plus TEST_SINK_URL.
import { createSafeFetch, type HttpFetch, sendConversion } from "@ebooktrivia/adapters";
import type { FireConversion } from "../../src/conversion-fire.ts";
import type { OutboxConsumer } from "../../src/outbox-consumer.ts";
import { runWorker } from "../../src/worker.ts";
import { PROBE_TOPIC } from "./probe.ts";

const sink = process.env["TEST_SINK_URL"];
if (sink === undefined) throw new Error("TEST_SINK_URL is required");
const safeFetch = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: 2000 });
const http: HttpFetch = (url, init) =>
  safeFetch(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });

const probe: OutboxConsumer = {
  topic: PROBE_TOPIC,
  leaseMs: 5000,
  perform: async (row, signal) => {
    const response = await safeFetch(`${sink}/outbox/${row.id}`, { method: "POST", signal });
    await response.cancel();
    if (response.status !== 200) throw new Error(`sink answered ${String(response.status)}`);
    return undefined;
  },
};

const fire: FireConversion = async (event) => {
  const url = `${sink}/conv/${event.id}?attempt=${String(event.attempt)}`;
  const result = await sendConversion(http, { method: "POST", url, headers: { accept: "application/json" }, redacted: { url: `${sink}/conv/[id]` } });
  return { ...result, requestUrlRedacted: `${sink}/conv/[id]` };
};

await runWorker(process.env, { outboxConsumers: [probe], fireConversion: fire });
