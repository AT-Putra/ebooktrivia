// Fixtures of the landing-page SDK e2e (US-019, M6a):
//   - startSdkStub: a stand-in for the public API (US-020 checkout, US-024 visit and config) that
//     implements the wire contract of @ebooktrivia/core/sdk-contract, serves the SDK build the way
//     api.<DOMAIN>/sdk/ does, and answers Cap with the real @ebooktrivia/adapters Cap provider
//     (@cap.js/server), so the real widget solves real challenges. CORS and Origin behave like
//     production: only the registered landing-page origin gets CORS headers, a request from any other
//     origin is refused without them, and nothing is ever accepted with cookies.
//   - startLpFixture: a landing page on ANOTHER origin (another port) with a strict CSP, a form bound
//     through the data attributes, and the snippet.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createCapProvider, createMemoryReplayStore } from "@ebooktrivia/adapters";
import { normalizeIdMobile } from "@ebooktrivia/core";
import type { SdkCheckoutResponse, SdkErrorBody, SdkLpConfig, SdkVisitResponse } from "@ebooktrivia/core/sdk-contract";

export const LP_KEY = "lp_E2eSdkFixture0123456789ab";
export const SNAP_SANDBOX_URL = "https://app.sandbox.midtrans.com/snap/v4/redirection/e2e-token";
export const VALUE_IDR = 49_000;
export const LEGAL = { program: "juni-2026", terms: 3, privacy: 2 } as const;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
  readonly body: unknown;
}

export interface SdkStub {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /** The files requested from /sdk/, in order. */
  readonly files: string[];
  /** The checkout answers (200) the stub has given, in order. */
  readonly checkouts: SdkCheckoutResponse[];
  /** The only origin that gets CORS headers (the landing page). */
  allowOrigin: string;
  /** What checkout answers as `snap_redirect_url`. */
  snapRedirectUrl: string;
  /** Delay before checkout answers. */
  checkoutDelayMs: number;
  /** Forces `deduped` to false even for a phone that already has an order. */
  neverDeduped: boolean;
  config: { -readonly [K in keyof SdkLpConfig]: SdkLpConfig[K] };
  /** Requests whose path starts with `prefix`. */
  seen(prefix: string): RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

const SDK_MIME = "text/javascript; charset=utf-8";
const FILE = /^(?:(?:sdk|cap)-v[0-9]+\.[0-9]+\.[0-9]+\.js|cap-(?:wasm|hashwx)-v[0-9]+\.[0-9]+\.[0-9]+\.wasm|v[0-9]+\.js)$/;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size === 0 || size > 64 * 1024) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
  });
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function startSdkStub(options: { readonly sdkDir: string }): Promise<SdkStub> {
  const cap = createCapProvider({ replay: createMemoryReplayStore(), challengeCount: 8, challengeSize: 16, challengeDifficulty: 2 });
  const orders = new Map<string, string>();
  const requests: RecordedRequest[] = [];
  const answers: SdkCheckoutResponse[] = [];
  const files: string[] = [];
  let origin = "";

  const stub: SdkStub = {
    get origin() {
      return origin;
    },
    requests,
    files,
    checkouts: answers,
    allowOrigin: "",
    snapRedirectUrl: SNAP_SANDBOX_URL,
    checkoutDelayMs: 0,
    neverDeduped: false,
    config: undefined as never,
    seen: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    reset() {
      requests.length = 0;
      files.length = 0;
      answers.length = 0;
      orders.clear();
      stub.snapRedirectUrl = SNAP_SANDBOX_URL;
      stub.checkoutDelayMs = 0;
      stub.neverDeduped = false;
      stub.config = defaultConfig();
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  const defaultConfig = (): SdkLpConfig => ({
    v: 1,
    lp_key: LP_KEY,
    checkout_open: true,
    adnets: [
      { slug: "adnet-a", clickid_param: "cid" },
      { slug: "adnet-b", clickid_param: "aff_click_id" },
    ],
    pixels: { meta: "1234567890123" },
    midtrans_env: "sandbox",
    legal: { play_origin: "http://127.0.0.1:4999", ...LEGAL },
  });
  stub.config = defaultConfig();

  async function checkout(body: unknown): Promise<{ status: number; json: SdkCheckoutResponse | SdkErrorBody }> {
    const fail = (status: number, error: SdkErrorBody["error"], fields?: SdkErrorBody["fields"]) => ({ status, json: { v: 1 as const, error, ...(fields === undefined ? {} : { fields }) } });
    if (!isRecord(body) || body["v"] !== 1 || !isRecord(body["consent"]) || !isRecord(body["attribution"])) return fail(400, "validation");
    const { name, phone, email, cap_token: capToken, consent } = body as Record<string, unknown> & { consent: Record<string, unknown> };
    if (typeof name !== "string" || typeof phone !== "string" || typeof email !== "string" || typeof capToken !== "string") return fail(400, "validation");
    const normalized = normalizeIdMobile(phone);
    if (!normalized.ok) return fail(400, "validation", { phone: normalized.error });
    if (name.trim() === "" || name.length > 120) return fail(400, "validation", { name: name.trim() === "" ? "required" : "too_long" });
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return fail(400, "validation", { email: "invalid" });
    const legal = stub.config.legal;
    if (legal === null || consent["terms"] !== legal.terms || consent["privacy"] !== legal.privacy) return fail(400, "validation", { consent: "outdated" });
    // A Cap token works once: verify() is true the first time only.
    if (!(await cap.verify(capToken))) return fail(403, "captcha");
    const existing = orders.get(normalized.e164);
    const eventId = existing ?? randomUUID();
    orders.set(normalized.e164, eventId);
    const answer: SdkCheckoutResponse = { v: 1, event_id: eventId, snap_redirect_url: stub.snapRedirectUrl, value_idr: VALUE_IDR, deduped: existing !== undefined && !stub.neverDeduped };
    answers.push(answer);
    return { status: 200, json: answer };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    const method = req.method ?? "GET";

    // The SDK files, as api.<DOMAIN>/sdk/ serves them (infra/caddy/Caddyfile).
    if (method === "GET" && url.pathname.startsWith("/sdk/")) {
      const name = url.pathname.slice("/sdk/".length);
      if (!FILE.test(name)) {
        send(res, 404);
        return;
      }
      const cache = name === "v1.js" ? "public, max-age=300" : "public, max-age=31536000, immutable";
      files.push(name);
      // The headers of the /sdk/* route of infra/caddy/Caddyfile: a page on another origin fetch()es the wasm.
      res.writeHead(200, { "content-type": name.endsWith(".wasm") ? "application/wasm" : SDK_MIME, "cache-control": cache, "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
      res.end(readFileSync(join(options.sdkDir, name)));
      return;
    }

    const match = /^\/api\/v1\/(lp|visit|cap|checkout)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) {
      send(res, 404);
      return;
    }
    const requestOrigin = req.headers.origin;
    const allowed = requestOrigin !== undefined && requestOrigin === stub.allowOrigin;
    // Only the registered landing-page origin gets CORS headers; the browser blocks the rest.
    const cors: Record<string, string> = allowed ? { "access-control-allow-origin": requestOrigin, vary: "Origin" } : {};
    if (method === "OPTIONS") {
      if (allowed) send(res, 204, undefined, { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, accept", "access-control-max-age": "600" });
      else send(res, 403);
      return;
    }
    const body = method === "POST" ? await readBody(req) : undefined;
    requests.push({ method, path: url.pathname, origin: requestOrigin, cookie: req.headers.cookie, body });
    if (!allowed) {
      send(res, 403, { v: 1, error: "origin" } satisfies SdkErrorBody);
      return;
    }
    if (match[2] !== LP_KEY) {
      send(res, 404, undefined, cors);
      return;
    }

    switch (match[1]) {
      case "lp":
        send(res, 200, stub.config, { ...cors, "cache-control": "public, max-age=60" });
        return;
      case "visit":
        send(res, 200, { v: 1, visit_id: randomUUID() } satisfies SdkVisitResponse, cors);
        return;
      case "cap":
        if (method !== "POST") send(res, 405, undefined, cors);
        else if (match[3] === "/challenge") send(res, 200, await cap.challenge(), cors);
        else if (match[3] === "/redeem") send(res, 200, await cap.redeem(body), cors);
        else send(res, 404, undefined, cors);
        return;
      default: {
        if (method !== "POST") {
          send(res, 405, undefined, cors);
          return;
        }
        if (stub.checkoutDelayMs > 0) await new Promise((r) => setTimeout(r, stub.checkoutDelayMs));
        const result = await checkout(body);
        send(res, result.status, result.json, cors);
      }
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return stub;
}

export interface LpFixture {
  readonly origin: string;
  close(): Promise<void>;
}

const page = (apiOrigin: string, withSdk: boolean): string => `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ebook Trivia, halaman penjualan</title>
<link rel="stylesheet" href="/lp.css">
</head>
<body>
<main>
<h1>Ebook Trivia</h1>
<form data-ebt-checkout id="checkout" action="/never-submitted-natively" method="post">
<p><label for="name">Nama lengkap</label> <input id="name" name="name" data-ebt-field="name" autocomplete="name" required></p>
<p><label for="phone">Nomor WhatsApp</label> <input id="phone" name="phone" data-ebt-field="phone" inputmode="tel" autocomplete="tel" required></p>
<p><label for="email">E-mail</label> <input id="email" name="email" type="email" data-ebt-field="email" autocomplete="email" required></p>
<p><label><input id="consent" type="checkbox" data-ebt-consent> <span data-ebt-consent-label></span></label></p>
<p><button id="buy" type="submit" disabled>Beli sekarang</button></p>
</form>
</main>
${withSdk ? `<script src="${apiOrigin}/sdk/v1.js" data-lp="${LP_KEY}" async></script>\n` : ""}</body>
</html>
`;

/**
 * Landing pages on their own origin, under a strict CSP: no inline script or style, no eval, only the
 * API and the Meta pixel host for scripts, only the API for connections.
 *   /lp.html         the CSP an LP author is told to use (README): script-src with 'wasm-unsafe-eval'
 *   /lp-nowasm.html  the same without 'wasm-unsafe-eval': WebAssembly cannot be compiled, Cap must fall back
 *   /lp-nosdk.html   the page without the snippet (the script never loaded)
 */
export async function startLpFixture(apiOrigin: string): Promise<LpFixture> {
  const csp = (scriptSrc: string): string =>
    [
      "default-src 'none'",
      `script-src ${scriptSrc}`,
      `connect-src ${apiOrigin}`,
      "worker-src blob:",
      "style-src 'self'",
      "img-src 'self' data:",
      "form-action 'self'",
      "base-uri 'none'",
    ].join("; ");
  const withWasm = csp(`${apiOrigin} https://connect.facebook.net 'wasm-unsafe-eval'`);
  const withoutWasm = csp(`${apiOrigin} https://connect.facebook.net`);
  const pages: Record<string, { csp: string; sdk: boolean }> = {
    "/lp.html": { csp: withWasm, sdk: true },
    "/lp-nowasm.html": { csp: withoutWasm, sdk: true },
    "/lp-nosdk.html": { csp: withWasm, sdk: false },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://lp.invalid");
    const served = pages[url.pathname];
    if (served !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": served.csp, "cache-control": "no-store" });
      res.end(page(apiOrigin, served.sdk));
      return;
    }
    if (url.pathname === "/lp.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end("body{font-family:sans-serif;margin:2rem;color:#111;background:#fff}label{display:inline-block;min-width:9rem}");
      return;
    }
    res.writeHead(url.pathname === "/favicon.ico" ? 204 : 404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
