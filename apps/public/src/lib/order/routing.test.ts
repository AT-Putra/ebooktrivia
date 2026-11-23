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

// US-026 security review L2: the player login lives on the play origin only.
describe("the player login (play.<DOMAIN> only)", () => {
  const PLAY_PAGES = ["/login", "/masuk", "/login/", "/Login", "/%6Cogin", "/MASUK"];
  const PLAY_API = ["/api/v1/play/auth/otp", "/api/v1/play/auth/otp/verify", "/api/v1/play/auth/magic-link", "/api/v1/play/auth/logout", "/api/v1/play/auth/session", "/api/v1/play/cap/challenge", "/api/v1/play/cap/redeem", "/api/v1/play/img/set/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000001.webp", "/api/v1/play/img/prize/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000001.webp", "/api/v1/play/img/banner/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000001.webp", "/API/V1/PLAY/auth/otp", "/api/v1/%70lay/auth/otp", "/api/v1/play"];

  it("serves the login pages (with the play CSP) and every /api/v1/play route on play.<DOMAIN>", () => {
    for (const path of PLAY_PAGES) expect(route(`play.${DOMAIN}`, path), path).toEqual({ kind: "playPage" });
    for (const path of PLAY_API) expect(route(`play.${DOMAIN}:443`, path), path).toEqual({ kind: "playApi" });
  });

  it("answers them 404 on every other host, in every spelling, and without a DOMAIN", () => {
    for (const host of [`api.${DOMAIN}`, `admin.${DOMAIN}`, "lp.example.test", `play.${DOMAIN}.evil.test`, `xplay.${DOMAIN}`, "127.0.0.1:3100", "", null]) {
      for (const path of [...PLAY_PAGES, ...PLAY_API]) expect(route(host, path), `${String(host)} ${path}`).toEqual({ kind: "notFound" });
    }
    for (const path of [...PLAY_PAGES, ...PLAY_API]) expect(route(`play.${DOMAIN}`, path, null, null), path).toEqual({ kind: "notFound" });
  });

  it("is the order origin's one 404 there (no play route on order.<DOMAIN>)", () => {
    for (const path of ["/login", "/masuk"]) expect(route(`order.${DOMAIN}`, path)).toEqual({ kind: "orderPage", publicId: null });
    for (const path of ["/api/v1/play/auth/otp", "/api/v1/play/cap/challenge"]) expect(route(`order.${DOMAIN}`, path)).toEqual({ kind: "orderPage", publicId: null });
  });

  it("moves to the dev play host (PUBLIC_DEV_PLAY_ORIGIN) when one is given, and only there", () => {
    const dev = (host: string, path: string) => routeOrder({ host, domain: DOMAIN, pathname: path, orderIdParam: null, playHost: "127.0.0.1" });
    expect(dev("127.0.0.1:3103", "/login")).toEqual({ kind: "playPage" });
    expect(dev("127.0.0.1:3103", "/api/v1/play/auth/otp")).toEqual({ kind: "playApi" });
    expect(dev("localhost:3103", "/login")).toEqual({ kind: "notFound" });
    expect(dev(`play.${DOMAIN}`, "/login")).toEqual({ kind: "notFound" });
  });

  it("does not take /loginx, /masukan or /api/v1/players for a play route", () => {
    for (const path of ["/loginx", "/masukan", "/api/v1/players", "/api/v1/playx/a"]) expect(route(`api.${DOMAIN}`, path), path).toEqual({ kind: "pass" });
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

  // US-025: the WAHA webhook (server to server) and the signed ebook download (WAHA, and the e-mail fallback link) are api.<DOMAIN> routes. They
  // pass the gating everywhere except the order origin (the order page and nothing else: the same 404 page as an unknown order); the download route itself answers 404 on any host
  // but the api host.
  it("passes the WAHA webhook and the signed file download through, except on the order origin", () => {
    for (const path of ["/api/v1/webhooks/waha", "/files/deliverables/9b2a6f6e-0f4e-4f6b-8f0e-1f2d3c4b5a69.pdf"]) {
      for (const host of [`api.${DOMAIN}`, `play.${DOMAIN}`, "lp.example.test", null]) expect(route(host, path), `${String(host)} ${path}`).toEqual({ kind: "pass" });
      expect(route(`order.${DOMAIN}`, path), path).toEqual({ kind: "orderPage", publicId: null });
    }
  });

  // US-024: the SDK's config and visit routes are called from the landing pages' own origins against api.<DOMAIN>; the
  // route itself checks the Origin against the page's registered hosts, so host gating must let them through everywhere
  // except the order origin, which serves the order page only.
  it("passes the SDK's config and visit routes on the api host, a landing page host, the play host and without a DOMAIN", () => {
    for (const path of ["/api/v1/lp/lp_AbCdEfGh12345678/config", "/api/v1/visit/lp_AbCdEfGh12345678", "/api/v1/lp/lp_AbCdEfGh12345678/config/", "/API/V1/LP/lp_x/config"]) {
      for (const host of [`api.${DOMAIN}`, `play.${DOMAIN}`, "lp.example.test", "shop.landing.test", "127.0.0.1:3100", null]) expect(route(host, path), `${String(host)} ${path}`).toEqual({ kind: "pass" });
      expect(route(`api.${DOMAIN}`, path, null, null), path).toEqual({ kind: "pass" });
    }
  });

  it("does not serve the SDK routes on the order origin: the same 404 as an unknown order", () => {
    for (const path of ["/api/v1/lp/lp_AbCdEfGh12345678/config", "/api/v1/visit/lp_AbCdEfGh12345678"]) expect(route(`order.${DOMAIN}`, path), path).toEqual({ kind: "orderPage", publicId: null });
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
    `/_next/data/${BUILD}/login.json`,
    `/_next/data/${BUILD}/masuk.json`,
    `/_next/data/${BUILD}/api/v1/play/auth/otp.json`,
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

describe("the trivia pages (US-027: play.<DOMAIN> only, internal /trivia routes)", () => {
  const PLAY = `play.${DOMAIN}`;

  it("rewrites /, /{programSlug} and /{programSlug}/set/{n} on the play origin to the internal routes", () => {
    expect(route(PLAY, "/")).toEqual({ kind: "trivia", target: "/trivia" });
    expect(route(PLAY, "/juni-2026")).toEqual({ kind: "trivia", target: "/trivia/juni-2026" });
    expect(route(`${PLAY}:443`, "/ebook7")).toEqual({ kind: "trivia", target: "/trivia/ebook7" });
    expect(route(PLAY, "/juni-2026/set/12")).toEqual({ kind: "trivia", target: "/trivia/juni-2026/set/12" });
    // A program may be called "trivia": on the play origin that is its page.
    expect(route(PLAY, "/trivia")).toEqual({ kind: "trivia", target: "/trivia/trivia" });
    const dev = routeOrder({ host: "127.0.0.1:3104", domain: DOMAIN, pathname: "/juni-2026", orderIdParam: null, playHost: "127.0.0.1" });
    expect(dev).toEqual({ kind: "trivia", target: "/trivia/juni-2026" });
  });

  it("answers the internal routes 404 on every host, in every spelling", () => {
    for (const host of [PLAY, `api.${DOMAIN}`, `order.${DOMAIN}`, "lp.example.test", null]) {
      for (const path of ["/trivia/juni-2026", "/trivia/juni-2026/set/1", "/TRIVIA/x", "/%74rivia/x", "/trivia/"]) {
        const answer = route(host, path);
        expect(answer.kind === "notFound" || (answer.kind === "orderPage" && answer.publicId === null), `${String(host)} ${path}`).toBe(true);
      }
    }
    for (const host of [`api.${DOMAIN}`, "lp.example.test", null]) expect(route(host, "/trivia"), String(host)).toEqual({ kind: "notFound" });
  });

  it("serves no trivia page on any other host, and takes no other spelling or path for one", () => {
    for (const host of [`api.${DOMAIN}`, "lp.example.test", `play.${DOMAIN}.evil.test`, null]) {
      for (const path of ["/", "/juni-2026", "/juni-2026/set/1"]) expect(route(host, path).kind, `${String(host)} ${path}`).toBe("pass");
    }
    for (const path of ["/Juni-2026", "/juni_2026", "/juni-2026/", "/juni-2026/set/0", "/juni-2026/set/01", "/juni-2026/set/x", "/juni-2026/sets/1", "/a/b", "/-x", "/x-", "/mockups", "/icon.svg"]) {
      expect(route(PLAY, path), path).toEqual({ kind: "pass" });
    }
    // The login, legal and API routes keep their own answers.
    expect(route(PLAY, "/login")).toEqual({ kind: "playPage" });
    expect(route(PLAY, "/legal/p/terms/1")).toEqual({ kind: "legal" });
    expect(route(PLAY, "/api/v1/play/attempts/current")).toEqual({ kind: "playApi" });
  });
});
