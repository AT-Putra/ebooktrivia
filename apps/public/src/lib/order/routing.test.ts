// Host gating of the order page and the legal pages: what each host serves, and the one 404 for the rest.
import { describe, expect, it } from "vitest";
import { hostName, isNextDataPath, routeOrder } from "./routing.ts";

const DOMAIN = "example.test";
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const route = (host: string | null, pathname: string, orderIdParam: string | null = null, domain: string | null = DOMAIN) => routeOrder({ host, domain, pathname, orderIdParam });

describe("hostName", () => {
  it("lowercases, trims and drops the port", () => {
    expect(hostName("Order.Example.Test:3205")).toBe("order.example.test");
    expect(hostName(" order.example.test ")).toBe("order.example.test");
    expect(hostName("[::1]:3000")).toBe("[::1]");
    expect(hostName(null)).toBe("");
  });
});

describe("order.<DOMAIN>", () => {
  const host = `order.${DOMAIN}`;

  it("serves /{publicId} as the page of that order, with or without the Midtrans query", () => {
    expect(route(host, `/${ID}`)).toEqual({ kind: "orderPage", publicId: ID });
    expect(route(host, `/${ID}`, `${ID}-3`)).toEqual({ kind: "orderPage", publicId: ID });
    expect(route(`ORDER.${DOMAIN}:3205`, `/${ID}`)).toEqual({ kind: "orderPage", publicId: ID });
  });

  it("serves the dashboard redirect /?order_id={publicId}-{n} as that order's page", () => {
    expect(route(host, "/", `${ID}-1`)).toEqual({ kind: "orderPage", publicId: ID });
    expect(route(host, "/", `${ID}-12`)).toEqual({ kind: "orderPage", publicId: ID });
  });

  it("serves the root without a usable order_id as the shell", () => {
    expect(route(host, "/")).toEqual({ kind: "orderShell" });
    for (const bad of ["", "x-1", ID, `${ID}-`, `${ID}-1234`, `${ID}-1x`, `${ID}/../x-1`, "a".repeat(41) + "-1"]) expect(route(host, "/", bad), bad).toEqual({ kind: "orderShell" });
  });

  it("answers a malformed id like an unknown one: the same page with no id", () => {
    for (const path of ["/short", `/${ID}x`.padEnd(60, "x"), `/${ID}/`, `/${ID}/extra`, "/a-b", "/favicon.ico", "/robots.txt", "/%00", "/order/" + ID, "/legal/p/terms/1", "/mockups/order/paid", "/api/v1/checkout/lp_x"]) {
      expect(route(host, path), path).toEqual({ kind: "orderPage", publicId: null });
    }
  });

  it("serves exactly the two order API routes", () => {
    expect(route(host, "/api/v1/order/status")).toEqual({ kind: "orderApi" });
    expect(route(host, "/api/v1/order/claim")).toEqual({ kind: "orderApi" });
    for (const path of ["/api/v1/order", "/api/v1/order/", "/api/v1/order/other", "/api/v1/order/status/x", "/api/v1/cap/lp_x/challenge"]) expect(route(host, path), path).toEqual({ kind: "orderPage", publicId: null });
  });

  it("matches the path as sent: an encoded spelling of a route is no route", () => {
    expect(route(host, "/api%2Fv1/order/status")).toEqual({ kind: "orderPage", publicId: null });
    expect(route(host, `/%41${ID.slice(1)}`)).toEqual({ kind: "orderPage", publicId: null });
    expect(route(host, "/%E0%A4%A")).toEqual({ kind: "orderPage", publicId: null });
  });

  it("refuses an undecodable path on any other host", () => {
    expect(route(`play.${DOMAIN}`, "/%E0%A4%A")).toEqual({ kind: "notFound" });
  });
});

describe("play.<DOMAIN>", () => {
  const host = `play.${DOMAIN}`;

  it("serves the legal pages", () => {
    expect(route(host, "/legal/juni-2026/terms/3")).toEqual({ kind: "legal" });
    expect(route(host, "/Legal/juni-2026/terms/3")).toEqual({ kind: "legal" });
  });

  it("does not serve the order routes", () => {
    for (const path of ["/order", "/order/x", `/order/${ID}`, "/Order/x", "/api/v1/order/status", "/api/v1/order/claim", "/api/v1/order"]) expect(route(host, path), path).toEqual({ kind: "notFound" });
    expect(route(host, `/${ID}`)).toEqual({ kind: "pass" });
  });
});

describe("any other host, or none configured", () => {
  it("serves neither the order nor the legal routes on api.<DOMAIN>, an LP host or an unknown host", () => {
    for (const host of [`api.${DOMAIN}`, `admin.${DOMAIN}`, "lp.example.test", "127.0.0.1:3100", `order.${DOMAIN}.evil.test`, `xorder.${DOMAIN}`, null]) {
      expect(route(host, "/legal/p/terms/1"), String(host)).toEqual({ kind: "notFound" });
      expect(route(host, "/order/x"), String(host)).toEqual({ kind: "notFound" });
      expect(route(host, "/api/v1/order/status"), String(host)).toEqual({ kind: "notFound" });
    }
  });

  it("passes everything else through untouched (checkout, Cap, mockups, assets)", () => {
    for (const path of ["/", "/api/v1/checkout/lp_x", "/api/v1/cap/lp_x/challenge", "/mockups/order/paid", "/mockups/trivia"]) {
      expect(route(`api.${DOMAIN}`, path), path).toEqual({ kind: "pass" });
      expect(route(null, path, null, null), path).toEqual({ kind: "pass" });
    }
  });

  it("fails closed without a DOMAIN: not even order.<anything> is the order origin", () => {
    expect(route("order.example.test", `/${ID}`, null, null)).toEqual({ kind: "pass" });
    expect(route("order.example.test", "/order/x", null, null)).toEqual({ kind: "notFound" });
    expect(route("play.example.test", "/legal/p/terms/1", null, null)).toEqual({ kind: "notFound" });
  });
});

// Next resolves a pages-router data route (/_next/data/{buildId}/{page}.json) to the page path BEFORE the proxy
// runs, and the build id is public. With skipProxyUrlNormalize the proxy sees the raw path, so the data route
// is refused on every host, in every spelling a router would decode (US-022 security N1).
describe("Next's data route", () => {
  const BUILD = "dC1lMmUtYnVpbGQ";
  const DATA_PATHS = [
    `/_next/data/${BUILD}/order/${ID}.json`,
    `/_next/data/${BUILD}/${ID}.json`,
    `/_next/data/${BUILD}/api/v1/order/status.json`,
    `/_next/data/${BUILD}/api/v1/order/claim.json`,
    `/_next/data/${BUILD}/legal/juni-2026/terms/3.json`,
    `/_next/data/${BUILD}/index.json`,
    "/_next/data",
    "/_next/data/",
    "/_NEXT/DATA/x/order.json",
    "/_Next/Data/x",
    "/_next/%64ata/x/order.json",
    "/_next/%44ATA/x/order.json",
    "/%5Fnext/data/x/order.json",
    "/%5fnext/%64ata/x/order.json",
    "/%255Fnext/data/x/order.json",
    "/%255fnext/%2564ata/x/order.json",
    "/%25255Fnext/data/x/order.json",
    "/_next%2Fdata/x/order.json",
    "/_next%2fdata%2fx%2forder.json",
    "/%5Fnext/data/x/%E0%A4%A.json",
    "/_next/data/x/%E0%A4%A.json",
  ];
  const HOSTS = [`order.${DOMAIN}`, `play.${DOMAIN}`, `api.${DOMAIN}`, `lp.${DOMAIN}`, `order.${DOMAIN}.`, `order.${DOMAIN}:3205`, "127.0.0.1", "", null];

  it("is refused outright: a 404 on the order origin, the play origin, an LP host, a trailing-dot host and no host at all", () => {
    for (const host of HOSTS) for (const path of DATA_PATHS) expect(route(host, path), `${String(host)} ${path}`).toEqual({ kind: "notFound" });
  });

  it("is refused with a DOMAIN configured or not, and whatever the order_id query says", () => {
    for (const path of DATA_PATHS) {
      expect(route(`order.${DOMAIN}`, path, null, null), path).toEqual({ kind: "notFound" });
      expect(route(`order.${DOMAIN}`, path, `${ID}-1`), path).toEqual({ kind: "notFound" });
    }
  });

  it("is recognised by isNextDataPath, and only for a path that really is the data route", () => {
    for (const path of DATA_PATHS) expect(isNextDataPath(path), path).toBe(true);
    for (const path of ["/", `/${ID}`, "/_next/static/chunks/app.js", "/_next/image", "/_next/datafoo/x", "/_next/x/data", "/data/_next/data", "/order/_next/data", "/%5Fnext/static/x", "/api/v1/order/status", "/_nextdata", "/%E0%A4%A"]) {
      expect(isNextDataPath(path), path).toBe(false);
    }
  });

  it("does not change the order origin's other answers", () => {
    expect(route(`order.${DOMAIN}`, `/${ID}`)).toEqual({ kind: "orderPage", publicId: ID });
    expect(route(`order.${DOMAIN}`, "/api/v1/order/status")).toEqual({ kind: "orderApi" });
    expect(route(`play.${DOMAIN}`, "/legal/juni-2026/terms/3")).toEqual({ kind: "legal" });
    expect(route(`play.${DOMAIN}`, "/_next/static/chunks/app.js")).toEqual({ kind: "pass" });
  });
});
