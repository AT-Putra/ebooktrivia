// A real local HTTP sink that counts requests per path (stands in for an adnet / CAPI endpoint and
// for the outbox probe's external effect). Every request is answered after `delayMs`.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Sink {
  readonly url: string;
  /** Requests per path, e.g. "/conv/<id>?attempt=1" -> 1. */
  readonly counts: Map<string, number>;
  total(prefix: string): number;
  close(): Promise<void>;
}

export async function startSink(options: { delayMs?: number } = {}): Promise<Sink> {
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    counts.set(path, (counts.get(path) ?? 0) + 1);
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, options.delayMs ?? 0);
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    counts,
    total: (prefix) => [...counts].filter(([path]) => path.startsWith(prefix)).reduce((n, [, c]) => n + c, 0),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
