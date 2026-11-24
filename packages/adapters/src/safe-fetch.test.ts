// US-012 criterion 1: SSRF-safe fetch. Every network test talks to a local server on 127.0.0.1
// (reachable only with devAllowLoopback) or is refused before any socket opens.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLookup, createSafeFetch, isBlockedAddress, isSafeFetchError, type Resolver, SafeFetchError, systemResolver } from "./safe-fetch.ts";

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SafeFetchError) return e.code;
    throw e;
  }
  throw new Error("expected the request to fail");
}

const fixed =
  (...addresses: string[]): Resolver =>
  () =>
    Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) })));

let server: Server;
let base: string;
const received: string[] = [];

// 16 MiB of zeros, about 16 KiB on the wire: undici decompresses it transparently.
const BOMB = gzipSync(Buffer.alloc(16 * 1024 * 1024));

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push(req.url ?? "");
    if (req.url === "/bomb") {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": String(BOMB.length) });
      res.end(BOMB);
      return;
    }
    if (req.url?.startsWith("/size/") === true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`"${"x".repeat(Number(req.url.slice(6)) - 2)}"`);
      return;
    }
    if (req.url === "/slow-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status_code":'); // headers and part of the body, then nothing
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    if (req.url === "/hang") return; // never answers
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "169.254.169.254", // cloud metadata
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.1.1", // CGNAT
    "127.0.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1", // ::ffff:10.0.0.1
    "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "2002:a00:1::1", // 6to4 of 10.0.0.1
    "2001:0:4136:e378::1", // Teredo
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("lets private networks through only for allowlisted hosts, and never loopback or metadata", () => {
    const allowlisted = { allowPrivate: true, allowLoopback: false };
    expect(isBlockedAddress("10.0.0.7", allowlisted)).toBe(false);
    expect(isBlockedAddress("192.168.1.5", allowlisted)).toBe(false);
    expect(isBlockedAddress("fd00::7", allowlisted)).toBe(false);
    expect(isBlockedAddress("169.254.169.254", allowlisted)).toBe(true);
    expect(isBlockedAddress("127.0.0.1", allowlisted)).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.7", allowlisted)).toBe(true);
  });

  // US-017: cloud metadata services that sit inside a PRIVATE range stay refused for the WAHA
  // private-IP allowlist too; their neighbours in the same private range do not.
  it.each(["fd00:ec2::254", "fd00:ec2::23", "fd00:ec2:ffff::1", "100.100.100.200"])("refuses metadata address %s even for an allowlisted host", (address) => {
    expect(isBlockedAddress(address, { allowPrivate: true, allowLoopback: false })).toBe(true);
    expect(isBlockedAddress(address, { allowPrivate: true, allowLoopback: true })).toBe(true);
  });

  it.each(["fd00:ec3::254", "fd00::ec2", "100.100.100.199", "100.100.100.201"])("keeps the private neighbour %s allowlistable", (address) => {
    expect(isBlockedAddress(address, { allowPrivate: true, allowLoopback: false })).toBe(false);
    expect(isBlockedAddress(address)).toBe(true);
  });
});

describe("URL checks (no socket is opened)", () => {
  const safeFetch = createSafeFetch({ resolver: () => Promise.reject(new Error("must not resolve")) });

  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.1/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[fd00::1]/",
    "https://0.0.0.0/",
    "https://2130706433/", // parsed as 127.0.0.1
    "https://0x7f.1/", // parsed as 127.0.0.1
  ])("refuses the IP literal in %s", async (url) => {
    expect(await failure(safeFetch(url))).toBe("blocked_address");
  });

  it.each(["http://example.com/", "ftp://example.com/", "file:///etc/passwd", "data:text/plain,x"])("refuses the scheme of %s", async (url) => {
    expect(await failure(safeFetch(url))).toBe("scheme_not_allowed");
  });

  it("refuses credentials in the URL and unparsable URLs", async () => {
    expect(await failure(safeFetch("https://user:pw@example.com/"))).toBe("invalid_url");
    expect(await failure(safeFetch("not a url"))).toBe("invalid_url");
  });
});

describe("connect-time lookup", () => {
  it("resolves once per connection and connects to exactly the checked address", async () => {
    let calls = 0;
    const resolver: Resolver = () => {
      calls++;
      return fixed("127.0.0.1")("");
    };
    const port = new URL(base).port;
    const safeFetch = createSafeFetch({ resolver, allowHttp: true, devAllowLoopback: true });
    const response = await safeFetch(`http://stub.test:${port}/hello`, { headers: { connection: "close" } });
    expect(await response.text()).toBe("ok");
    expect(calls).toBe(1);
    expect(received).toContain("/hello");
  });

  it("refuses a public-looking name that resolves to a private or loopback address (rebinding)", async () => {
    const port = new URL(base).port;
    for (const answer of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      const safeFetch = createSafeFetch({ resolver: fixed(answer), allowHttp: true });
      expect(await failure(safeFetch(`http://rebind.example:${port}/`))).toBe("blocked_address");
    }
  });

  it("refuses the whole request when any answer is blocked (mixed public/private answers)", async () => {
    const safeFetch = createSafeFetch({ resolver: fixed("93.184.216.34", "10.0.0.5") });
    expect(await failure(safeFetch("https://mixed.example/"))).toBe("blocked_address");
  });

  it("fails closed on resolver errors and empty answers", async () => {
    expect(await failure(createSafeFetch({ resolver: () => Promise.reject(new Error("NXDOMAIN")) })("https://gone.example/"))).toBe("dns_failed");
    expect(await failure(createSafeFetch({ resolver: fixed() })("https://empty.example/"))).toBe("dns_failed");
  });
});

describe("audited private-IP allowlist (WAHA)", () => {
  it("lets an allowlisted host reach a private network address", async () => {
    const safeFetch = createSafeFetch({ resolver: fixed("10.255.255.1"), allowPrivateHosts: ["waha.internal:3000"], timeoutMs: 300 });
    // Nothing listens there: the request gets past the policy and then times out or fails to connect.
    expect(["timeout", "request_failed"]).toContain(await failure(safeFetch("https://waha.internal:3000/api/sessions")));
  });

  it("is per host and port, and never covers loopback or metadata", async () => {
    const options = { allowPrivateHosts: ["waha.internal:3000"], timeoutMs: 300 };
    expect(await failure(createSafeFetch({ ...options, resolver: fixed("10.255.255.1") })("https://waha.internal:3001/"))).toBe("blocked_address");
    expect(await failure(createSafeFetch({ ...options, resolver: fixed("10.255.255.1") })("https://other.internal:3000/"))).toBe("blocked_address");
    expect(await failure(createSafeFetch({ ...options, resolver: fixed("169.254.169.254") })("https://waha.internal:3000/"))).toBe("blocked_address");
    expect(await failure(createSafeFetch({ ...options, resolver: fixed("127.0.0.1") })("https://waha.internal:3000/"))).toBe("blocked_address");
  });
});

describe("redirects and timeout", () => {
  const safeFetch = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: 300 });

  it("never follows a redirect", async () => {
    expect(await failure(safeFetch(`${base}/redirect`))).toBe("redirect_refused");
    expect(received.filter((u) => u.includes("meta-data"))).toEqual([]);
  });

  it("times out a request that gets no response", async () => {
    expect(await failure(safeFetch(`${base}/hang`))).toBe("timeout");
  });

  it("honours a caller abort signal as well", async () => {
    const controller = new AbortController();
    const pending = safeFetch(`${base}/hang`, { signal: controller.signal });
    controller.abort();
    expect(await failure(pending)).toBe("request_failed");
  });

  it("uses a 5 second timeout by default", async () => {
    const started = Date.now();
    const defaults = createSafeFetch({ allowHttp: true, devAllowLoopback: true });
    expect(await failure(defaults(`${base}/hang`))).toBe("timeout");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(7000);
  }, 10_000);
});

describe("M4: response bodies are capped (decoded bytes)", () => {
  const safeFetch = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: 3000 });

  it("refuses a gzip bomb once the decoded body passes the 1 MiB default", async () => {
    const response = await safeFetch(`${base}/bomb`);
    expect(await failure(response.text())).toBe("response_too_large");
  });

  it("caps text() and json() at maxBodyBytes, and reads bodies up to the cap", async () => {
    const capped = createSafeFetch({ allowHttp: true, devAllowLoopback: true, maxBodyBytes: 1024 });
    expect(await failure((await capped(`${base}/size/1025`)).text())).toBe("response_too_large");
    expect(await failure((await capped(`${base}/size/4096`)).json())).toBe("response_too_large");
    expect(await (await capped(`${base}/size/1024`)).json()).toHaveLength(1022);
    expect(await (await safeFetch(`${base}/size/524288`)).text()).toHaveLength(524_288);
    expect(() => createSafeFetch({ maxBodyBytes: 0 })).toThrow(RangeError);
  });

  it("textPrefix reads at most the given bytes and discards the rest", async () => {
    const prefix = await (await safeFetch(`${base}/bomb`)).textPrefix(1024);
    expect(prefix).toHaveLength(1024);
    expect(await (await safeFetch(`${base}/size/10`)).textPrefix(1024)).toBe(`"${"x".repeat(8)}"`);
  });
});

describe("M5: body-read failures are SafeFetchErrors", () => {
  it("a body that stalls after the headers is a timeout", async () => {
    const safeFetch = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: 300 });
    const response = await safeFetch(`${base}/slow-body`);
    expect(response.status).toBe(200);
    expect(await failure(response.json())).toBe("timeout");
  });

  it("a caller abort while reading the body is request_failed", async () => {
    const controller = new AbortController();
    const response = await createSafeFetch({ allowHttp: true, devAllowLoopback: true })(`${base}/slow-body`, { signal: controller.signal });
    const reading = response.text();
    controller.abort();
    expect(await failure(reading)).toBe("request_failed");
  });
});

describe("A1: IPv6 is global unicast (2000::/3) only", () => {
  it.each(["::ffff:0:a9fe:a9fe", "::ffff:0:a00:1", "3fff::1", "2001:2::1", "2001:10::1", "2001:20::1", "5f00::1", "4000::1", "::2"])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("refuses the SIIT literal https://[::ffff:0:a9fe:a9fe]/ before connecting", async () => {
    expect(await failure(createSafeFetch({ resolver: () => Promise.reject(new Error("must not resolve")) })("https://[::ffff:0:a9fe:a9fe]/"))).toBe("blocked_address");
  });

  it("still allows public global unicast and allowlisted ULA", () => {
    expect(isBlockedAddress("2a00:1450:4001:82a::200e")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedAddress("fd00::7", { allowPrivate: true, allowLoopback: false })).toBe(false);
  });
});

describe("A4: a refused redirect carries its HTTP status", () => {
  it("puts the status on the error", async () => {
    try {
      await createSafeFetch({ allowHttp: true, devAllowLoopback: true })(`${base}/redirect`);
      throw new Error("expected a redirect_refused");
    } catch (e) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(e).toMatchObject({ code: "redirect_refused", httpStatus: 302 });
    }
  });
});

describe("system resolver and the exported lookup", () => {
  it("uses the system resolver by default, and still refuses what it returns for localhost", async () => {
    expect(await failure(createSafeFetch()("https://localhost/"))).toBe("blocked_address");
    const answers = await systemResolver("localhost");
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => isBlockedAddress(a.address))).toBe(true);
  });

  it("reports a name that does not resolve as dns_failed", async () => {
    expect(await failure(createSafeFetch()("https://no-such-host.invalid/"))).toBe("dns_failed");
  });

  const lookup = (resolver: Resolver, options: { all?: boolean; family?: number }) =>
    new Promise<{ error: Error | null; address: unknown; family: unknown }>((resolve) => {
      connectLookup(resolver, { allowPrivate: false, allowLoopback: false })("h.example", options, (error, address, family) => {
        resolve({ error, address, family });
      });
    });

  it("answers single-address and family-restricted lookups from the checked answers", async () => {
    const both = fixed("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946");
    expect(await lookup(both, {})).toMatchObject({ error: null, address: "93.184.216.34", family: 4 });
    expect(await lookup(both, { family: 6 })).toMatchObject({ error: null, address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 });
    expect((await lookup(both, { all: true })).address).toHaveLength(2);
    const v4only = await lookup(fixed("93.184.216.34"), { family: 6 });
    expect(v4only.error).toBeInstanceOf(SafeFetchError);
    expect((v4only.error as SafeFetchError).code).toBe("dns_failed");
  });
});

describe("A10: close() releases the connection pools", () => {
  it("waits for an in-flight request, then refuses new ones, and is idempotent", async () => {
    const safeFetch = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: 3000 });
    const inFlight = safeFetch(`${base}/size/64`);
    const closing = safeFetch.close();
    expect(await (await inFlight).text()).toHaveLength(64);
    await closing;
    expect(await failure(safeFetch(`${base}/size/64`))).toBe("request_failed");
    await expect(safeFetch.close()).resolves.toBeUndefined();
  });
});

describe("isSafeFetchError", () => {
  /** A SafeFetchError as ANOTHER copy of this package throws it (a Next.js app has one copy per bundle): same name and shape. */
  const otherCopy = (code: string) => Object.assign(new Error("x"), { name: "SafeFetchError", code });

  it("is true for this copy's SafeFetchError and for another copy's (same name, a known code)", () => {
    expect(isSafeFetchError(new SafeFetchError("timeout", "x"))).toBe(true);
    expect(isSafeFetchError(otherCopy("timeout"))).toBe(true);
    expect(isSafeFetchError(otherCopy("blocked_address"))).toBe(true);
  });

  it("is false for anything else: other errors, an unknown code, a look-alike object that is not an Error", () => {
    expect(isSafeFetchError(new TypeError("terminated"))).toBe(false);
    expect(isSafeFetchError(otherCopy("not_a_code"))).toBe(false);
    expect(isSafeFetchError({ name: "SafeFetchError", code: "timeout" })).toBe(false);
    expect(isSafeFetchError(undefined)).toBe(false);
  });
});
