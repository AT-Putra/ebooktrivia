// The HTTP listener in front of a Next.js app (public@a/b, admin; plan M4.3). Before the app sees a
// request it:
//   - answers GET/HEAD /livez itself: 200, or 503 while draining. Caddy's load balancer
//     health-checks it (the deep /healthz is Uptime Kuma's, a later story). It is answered before
//     the app so that host gating in the app's proxy.ts cannot turn it into a 404;
//   - rewrites the client-address headers (client-ip.ts): only Caddy's pinned IP is believed.
// Draining starts on SIGTERM (podman stop, a rolling restart) or while the drain file exists
// (EDGE_DRAIN_FILE, a manual switch). On SIGTERM it waits drainMs (longer than Caddy's health
// interval + timeout, so Caddy has marked this upstream down), stops accepting, lets in-flight
// requests finish and exits. Responses sent while draining carry `Connection: close`, so Caddy does
// not keep reusing pooled connections to a backend that is going away.
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { applyClientIp } from "./client-ip.ts";

export type AppHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface EdgeListenerOptions {
  readonly trustedProxy: string | null;
  readonly isDraining: () => boolean;
  readonly handle: AppHandler;
  readonly onError?: (error: unknown) => void;
}

const LIVEZ = "/livez";
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

function pathOf(url: string | undefined): string {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

export function createEdgeListener(options: EdgeListenerOptions): RequestListener {
  return (req, res) => {
    const draining = options.isDraining();
    if (draining) res.setHeader("Connection", "close");
    if (pathOf(req.url) === LIVEZ) {
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }).end("method not allowed\n");
        return;
      }
      res.writeHead(draining ? 503 : 200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : draining ? "draining\n" : "ok\n");
      return;
    }
    applyClientIp(req, options.trustedProxy);
    const fail = (error: unknown) => {
      options.onError?.(error);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end();
    };
    try {
      const result = options.handle(req, res);
      if (result instanceof Promise) result.catch(fail);
    } catch (error) {
      fail(error);
    }
  };
}

export interface EdgeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly trustedProxy: string | null;
  readonly drainMs: number;
  readonly drainFile: string | undefined;
  /** In-flight requests get this long after the drain wait before the process exits anyway. */
  readonly closeTimeoutMs: number;
  readonly handle: AppHandler;
  readonly log: (message: string) => void;
}

export interface RunningEdge {
  readonly server: Server;
  readonly port: number;
  isDraining(): boolean;
  /** Starts draining: /livez answers 503 at once; after drainMs the server stops accepting and closes. */
  drain(): Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function startEdgeServer(options: EdgeServerOptions): Promise<RunningEdge> {
  let draining = false;
  const isDraining = () => draining || (options.drainFile !== undefined && existsSync(options.drainFile));
  const server = createServer(
    createEdgeListener({
      trustedProxy: options.trustedProxy,
      isDraining,
      handle: options.handle,
      onError: (error) => {
        options.log(`request failed: ${error instanceof Error ? error.name : "error"}`);
      },
    }),
  );
  // Longer than Caddy's upstream keepalive (30 s, infra/caddy/Caddyfile), so Caddy always closes an
  // idle pooled connection first and never sends a request on one this server is closing.
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let drained: Promise<void> | undefined;
  const drain = () => {
    drained ??= (async () => {
      draining = true;
      options.log(`draining: /livez answers 503, closing in ${String(options.drainMs)} ms`);
      await sleep(options.drainMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
        }, options.closeTimeoutMs);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      });
      options.log("drained");
    })();
    return drained;
  };
  return { server, port: (server.address() as AddressInfo).port, isDraining, drain };
}
