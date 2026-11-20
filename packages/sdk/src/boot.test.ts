// Booting: which script tag is ours, which API origin it may talk to (security review S2), and the
// capture at boot with the config arriving later (C5, owner decision O2).
import type { SdkAttribution, SdkLpConfig } from "@ebooktrivia/core/sdk-contract";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api.ts";
import type { AttributionDeps, KeyValueStore } from "./attribution.ts";
import { apiOriginOf, bootTarget, pickScript, type ServiceEnv, startServices } from "./boot.ts";

const LP = "lp_Abcdefgh12345678abcdefgh";
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
const VISIT_ID = "11111111-2222-4333-8444-555555555555";

describe("apiOriginOf", () => {
  it.each([
    ["https://api.example.test/sdk/v1.js", "https://api.example.test"],
    ["https://api.example.test:8443/sdk/v1.js?x=1", "https://api.example.test:8443"],
    ["http://127.0.0.1:4101/sdk/v1.js", "http://127.0.0.1:4101"],
    ["http://localhost:3000/sdk/v1.js", "http://localhost:3000"],
    ["http://[::1]:3000/sdk/v1.js", "http://[::1]:3000"],
  ])("accepts %s", (src, origin) => {
    expect(apiOriginOf(src)).toBe(origin);
  });

  it.each([
    ["plain http on a real host", "http://api.example.test/sdk/v1.js"],
    ["plain http on a look-alike of loopback", "http://127.0.0.1.evil.example/sdk/v1.js"],
    ["plain http on localhost.evil", "http://localhost.evil.example/sdk/v1.js"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/javascript,alert(1)"],
    ["blob:", "blob:https://api.example.test/x"],
    ["ftp:", "ftp://api.example.test/sdk/v1.js"],
    ["a relative URL", "/sdk/v1.js"],
    ["nothing", ""],
  ])("refuses %s", (_name, src) => {
    expect(apiOriginOf(src)).toBeNull();
  });
});

describe("pickScript", () => {
  const ours = { src: "https://api.example.test/sdk/v1.js", dataLp: LP };

  it("is the executing script (document.currentScript), whatever it is called", () => {
    const current = { src: "https://api.example.test/anything/sdk-copy.js", dataLp: LP };
    expect(pickScript(current, [ours])).toBe(current);
  });

  it.each(["https://api.example.test/sdk/v1.js", "https://api.example.test/sdk/sdk-v1.0.0.js", "https://api.example.test/sdk/sdk-v1.12.345.js?x=1"])("falls back to a data-lp tag whose path is the SDK's own: %s", (src) => {
    const tag = { src, dataLp: LP };
    expect(pickScript(null, [{ src: "https://cdn.example.test/analytics.js", dataLp: null }, tag])).toBe(tag);
    // The executing script has no src (inline): the same fallback.
    expect(pickScript({ src: "", dataLp: null }, [tag])).toBe(tag);
  });

  it.each([
    ["another file of the API's /sdk/ directory", "https://api.example.test/sdk/cap-v0.1.62.js"],
    ["another SDK major", "https://api.example.test/sdk/v2.js"],
    ["a path that only ends like it", "https://api.example.test/sdk/v1.js/evil"],
    ["a different directory", "https://api.example.test/static/v1.js"],
    ["a version that is not three numbers", "https://api.example.test/sdk/sdk-v1.0.js"],
    ["an arbitrary script with a data-lp attribute", "https://evil.example.test/tracker.js"],
  ])("does not take %s for the SDK", (_name, src) => {
    expect(pickScript(null, [{ src, dataLp: LP }])).toBeNull();
  });

  it("ignores a candidate without data-lp", () => {
    expect(pickScript(null, [{ src: "https://api.example.test/sdk/v1.js", dataLp: null }])).toBeNull();
  });
});

describe("bootTarget", () => {
  it("gives the lp key and the API origin of a sound tag", () => {
    expect(bootTarget({ src: "https://api.example.test/sdk/v1.js", dataLp: LP })).toEqual({ lpKey: LP, apiOrigin: "https://api.example.test" });
  });

  it.each([
    ["no tag", null],
    ["a plain-http API origin", { src: "http://api.example.test/sdk/v1.js", dataLp: LP }],
    ["no data-lp", { src: "https://api.example.test/sdk/v1.js", dataLp: null }],
    ["a malformed lp key", { src: "https://api.example.test/sdk/v1.js", dataLp: "lp_short" }],
    ["an lp key with markup in it", { src: "https://api.example.test/sdk/v1.js", dataLp: 'lp_abcdefgh12"><script>' }],
    ["a javascript: src", { src: "javascript:alert(1)", dataLp: LP }],
  ])("does not boot with %s", (_name, script) => {
    expect(bootTarget(script)).toBeNull();
  });
});

class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const CONFIG: SdkLpConfig = {
  v: 1,
  lp_key: LP,
  checkout_open: true,
  adnets: [{ slug: "adnet-a", clickid_param: "cid" }],
  pixels: {},
  midtrans_env: "sandbox",
  legal: null,
};

function world(search: string, options: { config?: SdkLpConfig | null | "never"; visit?: string | null; cookie?: string } = {}) {
  const storage = new MemoryStore();
  const session = new MemoryStore();
  const env = { cookie: options.cookie ?? "", now: T0 };
  const beacons: SdkAttribution[] = [];
  let release: (config: SdkLpConfig | null) => void = () => undefined;
  const config = options.config === "never" ? new Promise<SdkLpConfig | null>((resolve) => (release = resolve)) : Promise.resolve(options.config === undefined ? CONFIG : options.config);
  const api: Api = {
    config: () => config,
    visit: (attribution) => {
      beacons.push(attribution);
      return Promise.resolve(options.visit === undefined ? VISIT_ID : options.visit);
    },
    checkout: () => Promise.reject(new Error("not used")),
  };
  const deps = (): AttributionDeps => ({ storage, session, now: () => env.now, cookie: env.cookie });
  const serviceEnv: ServiceEnv = {
    lpKey: LP,
    apiOrigin: "https://api.example.test",
    search,
    deps,
    api,
    cap: { warm: vi.fn(), token: () => Promise.resolve(null), spent: vi.fn() },
    pixelsLoaded: () => false,
    pixelsFor: () => ({ enabled: false, loaded: () => false, prepare: () => Promise.resolve(), fireInitiateCheckout: () => Promise.resolve(false) }),
    navigate: vi.fn(),
  };
  return { storage, session, env, beacons, release, start: () => startServices(serviceEnv), serviceEnv };
}

const stored = (storage: MemoryStore): unknown => JSON.parse(storage.map.get(`ebt:attr:1:${LP}`) ?? "null");

describe("startServices: capture at boot, config later", () => {
  it("captures the fixed keys at once, before the config has arrived: a visitor who leaves keeps the click", () => {
    const w = world("?gclid=g1&utm_source=google&cid=zz9", { config: "never" });
    const svc = w.start();
    expect(stored(w.storage)).toMatchObject({ t: T0, a: { gclid: "g1", utm_source: "google" } });
    // The adnet's click id is not known yet; it waits in sessionStorage, and nothing was sent.
    expect(svc.attribution()).toEqual({ gclid: "g1", utm_source: "google" });
    expect(w.session.map.size).toBe(1);
    expect(w.beacons).toEqual([]);
    expect(svc.visitId()).toBeUndefined();
  });

  it("resolves the adnet's click id when the config arrives, then sends one visit beacon with the whole click", async () => {
    const w = world("?gclid=g1&cid=zz9", { config: "never" });
    const svc = w.start();
    w.release(CONFIG);
    await vi.waitFor(() => { expect(svc.visitId()).toBe(VISIT_ID); });
    expect(w.beacons).toEqual([{ gclid: "g1", clickid: "zz9", adnet: "adnet-a" }]);
    expect(svc.attribution()).toEqual({ gclid: "g1", clickid: "zz9", adnet: "adnet-a" });
    expect(w.session.map.size).toBe(0);
  });

  it("a config that cannot be loaded sends no beacon, but the click captured at boot is kept and still attached to an order", async () => {
    const w = world("?fbclid=fb1", { config: null });
    const svc = w.start();
    await expect(svc.config).resolves.toBeNull();
    await Promise.resolve();
    expect(w.beacons).toEqual([]);
    expect(svc.attribution()).toEqual({ fbclid: "fb1", fbc: `fb.1.${String(T0)}.fb1` });
    expect(stored(w.storage)).toMatchObject({ a: { fbclid: "fb1" } });
  });

  it("a UTM-only visit after a click sends the stored click, not the UTM (owner decision O2)", async () => {
    const first = world("?cid=AFF123");
    const a = first.start();
    await vi.waitFor(() => { expect(a.visitId()).toBe(VISIT_ID); });
    // The same stores, a later visit from a newsletter link.
    const second = world("?utm_source=newsletter");
    for (const [key, value] of first.storage.map) second.storage.map.set(key, value);
    const b = second.start();
    await vi.waitFor(() => { expect(b.visitId()).toBe(VISIT_ID); });
    expect(second.beacons).toEqual([{ adnet: "adnet-a", clickid: "AFF123" }]);
    expect(b.attribution()).toEqual({ adnet: "adnet-a", clickid: "AFF123" });
  });

  it("reads the Meta cookies fresh every time (the pixel may set them after the visit beacon)", async () => {
    const w = world("?cid=c1");
    const svc = w.start();
    await vi.waitFor(() => { expect(svc.visitId()).toBe(VISIT_ID); });
    expect(svc.attribution()).not.toHaveProperty("fbp");
    w.env.cookie = "_fbp=fb.1.1700000000000.1234567890";
    expect(svc.attribution()).toMatchObject({ clickid: "c1", fbp: "fb.1.1700000000000.1234567890" });
  });

  it("without a visit id (the beacon failed) the checkout simply carries none", async () => {
    const w = world("?cid=c1", { visit: null });
    const svc = w.start();
    await vi.waitFor(() => { expect(w.beacons).toHaveLength(1); });
    expect(svc.visitId()).toBeUndefined();
  });

  it("a visit with no parameters at all sends the stored click, or an empty attribution", async () => {
    const w = world("");
    const svc = w.start();
    await vi.waitFor(() => { expect(svc.visitId()).toBe(VISIT_ID); });
    expect(w.beacons).toEqual([{}]);
  });

  it("passes the API origin, the config promise and the injected ports through", () => {
    const w = world("");
    const svc = w.start();
    expect(svc.apiOrigin).toBe("https://api.example.test");
    expect(svc.cap).toBe(w.serviceEnv.cap);
    expect(svc.api).toBe(w.serviceEnv.api);
    expect(svc.navigate).toBe(w.serviceEnv.navigate);
  });
});
