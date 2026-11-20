// AC-T1: capture, 30-day storage, which visit replaces the stored click (owner decision O2), the
// two capture phases (C5), expiry, and hostile input.
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_TTL_MS, type AttributionDeps, current, type KeyValueStore, parseClick, parseFixed, PENDING_TTL_MS, readCookie, startCapture } from "./attribution.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
const LP = "lp_Abcdefgh12345678abcdefgh";
const ADNETS = [
  { slug: "adnet-a", clickid_param: "cid" },
  { slug: "adnet-b", clickid_param: "aff_click_id" },
];
const KEY = `ebt:attr:1:${LP}`;
const PENDING_KEY = `ebt:cand:1:${LP}`;
const NAMES_KEY = `ebt:names:1:${LP}`;

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

/** A clock the test moves, the two stores, and the deps built from them. */
function world(cookie = "") {
  const clock = { now: T0 };
  const storage = new MemoryStore();
  const session = new MemoryStore();
  const deps = (overrides: Partial<AttributionDeps> = {}): AttributionDeps => ({ storage, session, now: () => clock.now, cookie, ...overrides });
  /** One page load whose config arrives: capture at boot, resolve, and what would be sent. */
  const load = (search: string, adnets = ADNETS) => {
    const capture = startCapture(deps(), LP, search);
    capture.resolve(adnets);
    return current(deps(), LP, capture.click());
  };
  return { clock, storage, session, deps, load };
}

/** The entries parked in sessionStorage by the loads of this tab. */
const pendingEntries = (w: { readonly session: MemoryStore }): { readonly t: number; readonly c: readonly (readonly [string, string])[] }[] =>
  (JSON.parse(w.session.map.get(PENDING_KEY) ?? "{}") as { e: { t: number; c: [string, string][] }[] }).e;

describe("parseClick and parseFixed: what a landing URL may carry", () => {
  it("captures the click id under the adnet's own parameter name, plus sub params, UTM and platform ids", () => {
    const search = "?cid=ck-123&sub_id=s9&pub=p7&utm_source=fb&utm_medium=cpc&utm_campaign=Promo%20Besar&utm_content=c1&utm_term=t1&fbclid=FB.abc_1&ttclid=tt-1&gclid=g-1";
    expect(parseClick(search, ADNETS)).toEqual({
      adnet: "adnet-a",
      clickid: "ck-123",
      sub_id: "s9",
      pub: "p7",
      utm_source: "fb",
      utm_medium: "cpc",
      utm_campaign: "Promo Besar",
      utm_content: "c1",
      utm_term: "t1",
      fbclid: "FB.abc_1",
      ttclid: "tt-1",
      gclid: "g-1",
    });
  });

  it("parseFixed needs no config: it leaves the adnet's click id out", () => {
    expect(parseFixed("?cid=ck-123&sub_id=s9&gclid=g-1&adnet=adnet-a")).toEqual({ sub_id: "s9", gclid: "g-1" });
  });

  it("uses the second adnet's parameter name when that is the one present", () => {
    expect(parseClick("?aff_click_id=zz9", ADNETS)).toEqual({ clickid: "zz9", adnet: "adnet-b" });
  });

  it("lets adnet=<slug> pick between adnets that share a parameter name, and ignores a slug it does not know", () => {
    const shared = [
      { slug: "one", clickid_param: "clickid" },
      { slug: "two", clickid_param: "clickid" },
    ];
    expect(parseClick("?clickid=x1", shared)).toEqual({ clickid: "x1", adnet: "one" });
    expect(parseClick("?clickid=x1&adnet=two", shared)).toEqual({ clickid: "x1", adnet: "two" });
    expect(parseClick("?clickid=x1&adnet=evil-slug", shared)).toEqual({ clickid: "x1", adnet: "one" });
    // The slug comes from the config, never from the URL: no adnet, no click id.
    expect(parseClick("?adnet=two", shared)).toEqual({});
  });

  it("ignores every parameter that is not on the allowlist, personal data included", () => {
    expect(parseClick("?name=Budi&phone=081234567890&email=a%40b.co&token=secret&__proto__=x&constructor=y&utm_x=1", ADNETS)).toEqual({});
  });

  it("drops malformed values and keeps the good ones next to them", () => {
    const tooLong = "a".repeat(257);
    const search = `?cid=${tooLong}&sub_id=ok&pub=has%20space&gclid=${"g".repeat(512)}&fbclid=${"f".repeat(513)}&ttclid=%C3%A9t%C3%A9&utm_source=%00bad&utm_medium=a%0Ab&utm_term=x%E2%80%AEy`;
    expect(parseClick(search, ADNETS)).toEqual({ sub_id: "ok", gclid: "g".repeat(512) });
  });

  it("holds a click id of exactly 256 characters and rejects 257", () => {
    expect(parseClick(`?cid=${"a".repeat(256)}`, ADNETS)).toMatchObject({ clickid: "a".repeat(256) });
    expect(parseClick(`?cid=${"a".repeat(257)}`, ADNETS)).toEqual({});
  });

  it("trims UTM labels, accepts non-ASCII letters in them and drops an empty one", () => {
    expect(parseClick("?utm_source=%20newsletter%20&utm_campaign=Hari%20Ibu%20%F0%9F%8E%89&utm_medium=%20%20", ADNETS)).toEqual({ utm_source: "newsletter", utm_campaign: "Hari Ibu \u{1F389}" });
  });

  it("does not throw on a malformed query string", () => {
    expect(() => parseClick("?%E0%A4%A&cid=%zz&&=&utm_source=%", ADNETS)).not.toThrow();
  });
});

describe("an adnet whose click-id parameter is named like personal data (security review F1)", () => {
  // The console and the database refuse such names (migration 0010), but the SDK does not rely on that:
  // a contact detail is never a click id, whatever the parameter is called.
  const BAD = [
    { slug: "adnet-e", clickid_param: "email" },
    { slug: "adnet-p", clickid_param: "phone" },
  ];
  const VALUES = ["budi%40example.co", "a%40b", "0812-3456-7890", "081234567890", "%2B6281234567890", "6281234567890", "62%20812%203456%207890"];

  it.each(VALUES)("parseClick never takes %s under a configured click-id parameter", (value) => {
    expect(parseClick(`?email=${value}&phone=${value}`, BAD)).toEqual({});
  });

  it.each(VALUES)("%s under a configured parameter is never stored, never sent and never parked, on a first visit or with the names cached", (value) => {
    for (const cached of [false, true]) {
      const w = world();
      if (cached) w.load("", BAD); // the last config named email and phone as click-id parameters
      const capture = startCapture(w.deps(), LP, `?email=${value}&phone=${value}`);
      capture.resolve(BAD);
      expect(capture.click()).toBeNull();
      expect(current(w.deps(), LP, capture.click())).toEqual({});
      expect(w.storage.map.has(KEY)).toBe(false);
      expect(w.session.map.has(PENDING_KEY)).toBe(false);
    }
  });

  it("with the names cached, a contact value under the adnet's own name is not parked, though an ordinary value under it is", () => {
    const w = world();
    w.load("", BAD);
    startCapture(w.deps(), LP, "?email=budi%40example.co&phone=0812-3456-7890");
    expect(w.session.map.has(PENDING_KEY)).toBe(false);
    startCapture(w.deps(), LP, "?email=ordinary-1&phone=ordinary-2");
    expect(pendingEntries(w)[0]?.c).toEqual([
      ["email", "ordinary-1"],
      ["phone", "ordinary-2"],
    ]);
  });

  it("falls through to the next adnet when the first one's parameter carries a contact detail", () => {
    const adnets = [...BAD, { slug: "adnet-c", clickid_param: "cid" }];
    expect(parseClick("?email=budi%40example.co&cid=zz9", adnets)).toEqual({ clickid: "zz9", adnet: "adnet-c" });
  });

  it("keeps a numeric click id that is not a phone number, under a configured name (the 8-to-16-digit rule is for a first visit only)", () => {
    expect(parseClick("?cid=123456789012&aff_click_id=9876543210", ADNETS)).toEqual({ clickid: "123456789012", adnet: "adnet-a" });
    const w = world();
    expect(w.load("?cid=123456789012")).toEqual({ adnet: "adnet-a", clickid: "123456789012" });
    w.clock.now = T0 + DAY;
    w.session.map.clear();
    startCapture(w.deps(), LP, "?cid=777888999000"); // names are cached now: parked by name, not by value shape
    expect(pendingEntries(w)[0]?.c).toEqual([["cid", "777888999000"]]);
  });

  it("drops a stored click id that is a contact detail (a record written by something else), and keeps the rest of the record", () => {
    for (const clickid of ["budi@example.co", "081234567890", "+6281234567890"]) {
      const w = world();
      w.storage.map.set(KEY, JSON.stringify({ v: 1, t: T0, a: { clickid, adnet: "adnet-a", gclid: "g1" } }));
      expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", gclid: "g1" });
    }
  });

  it("resolving a parked click id applies the same rule", () => {
    const w = world();
    w.session.map.set(PENDING_KEY, JSON.stringify({ v: 1, e: [{ t: T0, w: null, f: {}, c: [["email", "budi@example.co"]] }] }));
    const capture = startCapture(w.deps(), LP, "");
    capture.resolve(BAD);
    expect(capture.click()).toBeNull();
  });
});

describe("which visit replaces the stored click (owner decision O2)", () => {
  it("stores a click and sends it after a reload without parameters", () => {
    const w = world();
    expect(w.load("?cid=first&sub_id=a")).toEqual({ adnet: "adnet-a", clickid: "first", sub_id: "a" });
    w.clock.now = T0 + 2 * DAY;
    expect(w.load("")).toEqual({ adnet: "adnet-a", clickid: "first", sub_id: "a" });
    expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "first", sub_id: "a" });
  });

  it("a new click id replaces the stored click whole: the old sub id and UTM do not ride along", () => {
    const w = world();
    w.load("?cid=first&sub_id=old&utm_source=fb");
    w.clock.now = T0 + DAY;
    expect(w.load("?cid=second")).toEqual({ adnet: "adnet-a", clickid: "second" });
    expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "second" });
  });

  it("the reviewer's probe: ?cid=AFF123, then ?utm_source=newsletter, keeps the click id (and sends no UTM with it)", () => {
    const w = world();
    w.load("?cid=AFF123");
    w.clock.now = T0 + DAY;
    expect(w.load("?utm_source=newsletter")).toEqual({ adnet: "adnet-a", clickid: "AFF123" });
    expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "AFF123" });
    expect(JSON.parse(w.storage.map.get(KEY) ?? "{}")).toMatchObject({ t: T0, a: { clickid: "AFF123" } });
  });

  it.each(["?sub_id=b", "?pub=other", "?utm_source=x&utm_medium=y&utm_campaign=z&utm_content=c&utm_term=t", "?ref=newsletter&page=2&email=a%40b.co", "?adnet=adnet-b"])(
    "a visit without an ad click id (%s) leaves the stored click untouched",
    (search) => {
      const w = world();
      w.load("?cid=keep&gclid=g1&sub_id=a");
      const before = w.storage.map.get(KEY);
      w.clock.now = T0 + DAY;
      expect(w.load(search)).toEqual({ adnet: "adnet-a", clickid: "keep", gclid: "g1", sub_id: "a" });
      expect(w.storage.map.get(KEY)).toBe(before);
    },
  );

  it.each([
    ["fbclid", "?fbclid=fb2", { fbclid: "fb2" }],
    ["ttclid", "?ttclid=tt2", { ttclid: "tt2" }],
    ["gclid", "?gclid=g2", { gclid: "g2" }],
    ["the other adnet's click id", "?aff_click_id=b2", { adnet: "adnet-b", clickid: "b2" }],
  ])("a new %s is an ad click id: it replaces the stored click", (_name, search, expected) => {
    const w = world();
    w.load("?cid=old&sub_id=a&gclid=g1");
    w.clock.now = T0 + DAY;
    // (fbc is built from an fbclid, so it is not part of what is compared.)
    const sent: Record<string, string> = { ...w.load(search) };
    delete sent["fbc"];
    expect(sent).toEqual(expected);
  });

  it("with nothing stored, a UTM-only visit is kept (first touch) so an organic order still carries it; a later UTM-only visit does not replace it", () => {
    const w = world();
    expect(w.load("?utm_source=newsletter&utm_campaign=juni")).toEqual({ utm_source: "newsletter", utm_campaign: "juni" });
    w.clock.now = T0 + DAY;
    expect(w.load("?utm_source=instagram")).toEqual({ utm_source: "newsletter", utm_campaign: "juni" });
    // An ad click id then replaces it.
    expect(w.load("?cid=ad1&utm_source=fb")).toEqual({ adnet: "adnet-a", clickid: "ad1", utm_source: "fb" });
  });

  it("opening the same click again keeps its first time: a reload never stretches the 30 days", () => {
    const w = world();
    w.load("?cid=aged&sub_id=s");
    w.clock.now = T0 + 20 * DAY;
    w.load("?cid=aged&sub_id=s");
    expect(JSON.parse(w.storage.map.get(KEY) ?? "{}")).toMatchObject({ t: T0 });
    w.clock.now = T0 + 31 * DAY;
    expect(w.load("")).toEqual({});
  });
});

describe("30 days", () => {
  it("keeps a click for 30 days from the click and expires it at 30 days exactly", () => {
    const w = world();
    w.load("?cid=aged");
    w.clock.now = T0 + ATTRIBUTION_TTL_MS - 1;
    expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "aged" });
    w.clock.now = T0 + ATTRIBUTION_TTL_MS;
    expect(current(w.deps(), LP)).toEqual({});
    expect(w.storage.map.has(KEY)).toBe(false);
    expect(ATTRIBUTION_TTL_MS).toBe(30 * DAY);
  });

  it("measures the 30 days from the click, so revisits without a click do not extend it", () => {
    const w = world();
    w.load("?cid=aged");
    w.clock.now = T0 + 20 * DAY;
    w.load("");
    w.clock.now = T0 + 31 * DAY;
    expect(startCapture(w.deps(), LP, "").click()).toBeNull();
    expect(current(w.deps(), LP)).toEqual({});
  });

  it("an expired click is replaced by a new one normally", () => {
    const w = world();
    w.load("?cid=old");
    w.clock.now = T0 + 45 * DAY;
    expect(w.load("?cid=new")).toEqual({ adnet: "adnet-a", clickid: "new" });
  });

  it("keeps landing pages apart", () => {
    const w = world();
    w.load("?cid=a");
    expect(current(w.deps(), "lp_Zzzzzzzz00000000zzzzzzzz")).toEqual({});
  });

  it("returns the click of this page load even when the store is blocked or absent", () => {
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    for (const storage of [blocked, null]) {
      const deps: AttributionDeps = { storage, session: storage, now: () => T0, cookie: "" };
      const capture = startCapture(deps, LP, "?cid=page&sub_id=s&gclid=g");
      capture.resolve(ADNETS);
      expect(capture.click()?.a).toEqual({ adnet: "adnet-a", clickid: "page", sub_id: "s", gclid: "g" });
      expect(current(deps, LP, capture.click())).toEqual({ adnet: "adnet-a", clickid: "page", sub_id: "s", gclid: "g" });
      expect(() => current(deps, LP)).not.toThrow();
      expect(current(deps, LP)).toEqual({});
    }
  });
});

describe("capture at boot, resolution when the config arrives (C5)", () => {
  it("captures the fixed keys at once, before any config: a visitor who leaves keeps their fbclid, gclid and UTM", () => {
    const w = world();
    const capture = startCapture(w.deps(), LP, "?gclid=g1&utm_source=google&cid=zz9");
    expect(capture.click()).toEqual({ t: T0, a: { gclid: "g1", utm_source: "google" } });
    expect(JSON.parse(w.storage.map.get(KEY) ?? "{}")).toMatchObject({ a: { gclid: "g1", utm_source: "google" } });
  });

  it("resolves the adnet's click id into the same click once the config is known", () => {
    const w = world();
    const capture = startCapture(w.deps(), LP, "?gclid=g1&cid=zz9");
    capture.resolve(ADNETS);
    expect(capture.click()).toEqual({ t: T0, a: { gclid: "g1", clickid: "zz9", adnet: "adnet-a" } });
    expect(w.session.map.has(PENDING_KEY)).toBe(false);
  });

  it("parks the URL's candidate parameters in sessionStorage until the config arrives", () => {
    const w = world();
    startCapture(w.deps(), LP, "?cid=zz9&utm_source=x");
    expect(JSON.parse(w.session.map.get(PENDING_KEY) ?? "{}")).toEqual({ v: 1, e: [{ t: T0, w: null, f: { utm_source: "x" }, c: [["cid", "zz9"]] }] });
  });

  it("when the config never arrived, the next load in the same tab resolves the earlier click id", () => {
    const w = world();
    startCapture(w.deps(), LP, "?cid=zz9&utm_source=x&gclid=g1"); // the visitor left before the config arrived
    w.clock.now = T0 + 60_000;
    const next = startCapture(w.deps(), LP, "");
    next.resolve(ADNETS);
    expect(next.click()).toEqual({ t: T0, a: { utm_source: "x", gclid: "g1", clickid: "zz9", adnet: "adnet-a" } });
    expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "zz9", utm_source: "x", gclid: "g1" });
    expect(w.session.map.has(PENDING_KEY)).toBe(false);
  });

  it("an earlier unresolved click id never replaces a newer click id", () => {
    const w = world();
    startCapture(w.deps(), LP, "?cid=old"); // never resolved
    w.clock.now = T0 + 60_000;
    w.load("?gclid=newer"); // resolves its own URL and the parked one; gclid=newer is a newer ad click
    w.clock.now = T0 + 120_000;
    expect(w.session.map.has(PENDING_KEY)).toBe(false);
    expect(current(w.deps(), LP)).toEqual({ gclid: "newer" });
  });

  it("an unresolved click id older than 30 minutes is forgotten, and its entry is removed", () => {
    const w = world();
    startCapture(w.deps(), LP, "?cid=zz9");
    w.clock.now = T0 + PENDING_TTL_MS;
    const next = startCapture(w.deps(), LP, "");
    next.resolve(ADNETS);
    expect(next.click()).toBeNull();
    expect(w.session.map.has(PENDING_KEY)).toBe(false);
  });

  it("drops the parked candidates once the config has arrived, whether or not one matched", () => {
    const w = world();
    const capture = startCapture(w.deps(), LP, "?unrelated=1&other=2");
    expect(w.session.map.has(PENDING_KEY)).toBe(true);
    capture.resolve(ADNETS);
    expect(w.session.map.has(PENDING_KEY)).toBe(false);
    expect(capture.click()).toBeNull();
  });

  describe("a reload of the same click does not restart the 30 days (E1)", () => {
    it("a reload on day 20 of ?cid=AFF1&gclid=G1 keeps the time and the adnet's click id, even when the config never arrives on that load", () => {
      const w = world();
      w.load("?cid=AFF1&gclid=G1");
      const first = w.storage.map.get(KEY);
      expect(JSON.parse(first ?? "{}")).toEqual({ v: 1, t: T0, a: { gclid: "G1", clickid: "AFF1", adnet: "adnet-a" } });
      w.clock.now = T0 + 20 * DAY;
      const reload = startCapture(w.deps(), LP, "?cid=AFF1&gclid=G1"); // boot only: the config has not arrived
      expect(w.storage.map.get(KEY)).toBe(first);
      expect(reload.click()).toEqual({ t: T0, a: { gclid: "G1", clickid: "AFF1", adnet: "adnet-a" } });
      expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "AFF1", gclid: "G1" });
      // The config arrives later in that load: still the same click, still the same time.
      reload.resolve(ADNETS);
      expect(w.storage.map.get(KEY)).toBe(first);
      // The 30 days count from the first load.
      w.clock.now = T0 + 31 * DAY;
      expect(w.load("")).toEqual({});
    });

    it("reloading with only part of the stored click (?gclid=G1) is the same click too", () => {
      const w = world();
      w.load("?cid=AFF1&gclid=G1&utm_source=fb");
      const first = w.storage.map.get(KEY);
      w.clock.now = T0 + 5 * DAY;
      startCapture(w.deps(), LP, "?gclid=G1&utm_source=fb");
      expect(w.storage.map.get(KEY)).toBe(first);
    });

    it("a click id that differs from the stored one is a new click and replaces it", () => {
      const w = world();
      w.load("?cid=AFF1&gclid=G1");
      w.clock.now = T0 + DAY;
      startCapture(w.deps(), LP, "?gclid=G2");
      expect(JSON.parse(w.storage.map.get(KEY) ?? "{}")).toEqual({ v: 1, t: T0 + DAY, a: { gclid: "G2" } });
    });
  });

  describe("a later load must not lose an earlier unresolved click (E3, E4)", () => {
    it("?cid=X, then a ?ref=nav load before the config arrives, keeps cid", () => {
      const w = world();
      startCapture(w.deps(), LP, "?cid=X"); // load 1: the config never arrived
      w.clock.now = T0 + 5_000;
      const second = startCapture(w.deps(), LP, "?ref=nav"); // load 2 parks its own candidates next to the first
      expect(pendingEntries(w)).toHaveLength(2);
      second.resolve(ADNETS);
      expect(second.click()).toEqual({ t: T0, a: { clickid: "X", adnet: "adnet-a" } });
      expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "X" });
      expect(w.session.map.has(PENDING_KEY)).toBe(false);
    });

    it("two unresolved ad clicks in one tab: the newer one wins", () => {
      const w = world();
      startCapture(w.deps(), LP, "?cid=first");
      w.clock.now = T0 + 5_000;
      startCapture(w.deps(), LP, "?cid=second");
      w.clock.now = T0 + 10_000;
      const third = startCapture(w.deps(), LP, "");
      third.resolve(ADNETS);
      expect(current(w.deps(), LP)).toEqual({ adnet: "adnet-a", clickid: "second" });
    });

    it("reloading the same URL before the config arrives parks it once, with its first time", () => {
      const w = world();
      startCapture(w.deps(), LP, "?cid=X");
      w.clock.now = T0 + 5_000;
      startCapture(w.deps(), LP, "?cid=X");
      const parked = JSON.parse(w.session.map.get(PENDING_KEY) ?? "{}") as { e: { t: number }[] };
      expect(parked.e).toHaveLength(1);
      expect(parked.e[0]?.t).toBe(T0);
    });

    it("parks at most the last 3 loads of a tab", () => {
      const w = world();
      for (const id of ["a1", "b2", "c3", "d4"]) {
        startCapture(w.deps(), LP, `?cid=${id}`);
        w.clock.now += 1_000;
      }
      const parked = JSON.parse(w.session.map.get(PENDING_KEY) ?? "{}") as { e: { c: string[][] }[] };
      expect(parked.e.map((e) => e.c[0]?.[1])).toEqual(["b2", "c3", "d4"]);
    });

    it("a first-touch UTM stored on a later load does not beat an earlier unresolved ad click (E4)", () => {
      const w = world();
      startCapture(w.deps(), LP, "?cid=X"); // load 1: no config, nothing stored (cid is not a fixed key)
      w.clock.now = T0 + 5_000;
      const second = startCapture(w.deps(), LP, "?utm_source=news"); // load 2: stores the UTM as first touch, at a later time
      expect(JSON.parse(w.storage.map.get(KEY) ?? "{}")).toMatchObject({ t: T0 + 5_000, a: { utm_source: "news" } });
      second.resolve(ADNETS);
      expect(second.click()).toEqual({ t: T0, a: { clickid: "X", adnet: "adnet-a" } });
    });

    it("a stored ad click that is NEWER than the unresolved one stays", () => {
      const w = world();
      startCapture(w.deps(), LP, "?cid=old");
      w.clock.now = T0 + 5_000;
      const second = startCapture(w.deps(), LP, "?gclid=newer");
      second.resolve(ADNETS);
      expect(second.click()).toEqual({ t: T0 + 5_000, a: { gclid: "newer" } });
    });

    it("a stored ad click that is OLDER than the unresolved one is replaced by it", () => {
      const w = world();
      w.load("?gclid=older");
      w.clock.now = T0 + 5_000;
      startCapture(w.deps(), LP, "?cid=newer"); // no config on this load
      w.clock.now = T0 + 6_000;
      const third = startCapture(w.deps(), LP, "");
      third.resolve(ADNETS);
      expect(third.click()).toEqual({ t: T0 + 5_000, a: { clickid: "newer", adnet: "adnet-a" } });
    });
  });

  describe("the adnets' click-id parameter names are learned and cached (E2, primary)", () => {
    it("remembers the names of the last config in localStorage, per landing page", () => {
      const w = world();
      w.load("");
      expect(JSON.parse(w.storage.map.get(NAMES_KEY) ?? "{}")).toEqual({ v: 1, t: T0, n: ["cid", "aff_click_id"] });
      expect(w.storage.map.has("ebt:names:1:lp_Zzzzzzzz00000000zzzzzzzz")).toBe(false);
    });

    it("with the names known, parks ONLY a parameter with one of those names", () => {
      const w = world();
      w.load(""); // learns cid and aff_click_id
      w.session.map.clear();
      startCapture(w.deps(), LP, "?cid=zz9&aff_click_id=bb7&ref=nav&utm_x=1&sid=12345&no_hp=0812&otp=1");
      expect(pendingEntries(w)[0]?.c).toEqual([
        ["cid", "zz9"],
        ["aff_click_id", "bb7"],
      ]);
    });

    it("with the names known, parks nothing for a URL that has none of them, and for a page without adnets", () => {
      const w = world();
      w.load("");
      startCapture(w.deps(), LP, "?ref=nav&page=2");
      expect(w.session.map.has(PENDING_KEY)).toBe(false);
      const none = world();
      none.load("", []);
      startCapture(none.deps(), LP, "?cid=zz9");
      expect(none.session.map.has(PENDING_KEY)).toBe(false);
    });

    it("trusts a numeric click id of an adnet whose name is known (the value rules are only for a first visit)", () => {
      const w = world();
      w.load("");
      startCapture(w.deps(), LP, "?cid=123456789012");
      expect(pendingEntries(w)[0]?.c).toEqual([["cid", "123456789012"]]);
    });

    it("forgets the names after 30 days and removes a malformed or hostile entry", () => {
      const w = world();
      w.load("");
      w.clock.now = T0 + 31 * DAY;
      startCapture(w.deps(), LP, "?no_hp=0812&cid=a1");
      // Names expired: back to the first-visit filter, and the entry is removed.
      expect(w.storage.map.has(NAMES_KEY)).toBe(false);
      const hostile = [
        "{oops",
        "[]",
        JSON.stringify({ v: 2, t: T0, n: [] }),
        JSON.stringify({ v: 1, t: "x", n: [] }),
        JSON.stringify({ v: 1, t: T0, n: "cid" }),
        JSON.stringify({ v: 1, t: T0, n: Array.from({ length: 101 }, (_, i) => `n${String(i)}`) }),
      ];
      for (const raw of hostile) {
        w.storage.map.set(NAMES_KEY, raw);
        w.session.map.clear();
        startCapture(w.deps(), LP, "?cid=a1&no_hp=0812");
        expect(w.storage.map.has(NAMES_KEY), raw).toBe(false);
        expect(pendingEntries(w)[0]?.c, raw).toEqual([["cid", "a1"]]);
      }
    });

    it("ignores a name in the cache that is not a plausible parameter name", () => {
      const w = world();
      w.storage.map.set(NAMES_KEY, JSON.stringify({ v: 1, t: T0, n: ["cid", "c id", 5, "a/b"] }));
      startCapture(w.deps(), LP, "?cid=zz9&c%20id=bad");
      expect(pendingEntries(w)[0]?.c).toEqual([["cid", "zz9"]]);
    });
  });

  describe("on a first visit, the parked copy holds nothing personal (E2, fallback)", () => {
    const parked = (search: string): [string, string][] => {
      const w = world();
      startCapture(w.deps(), LP, search);
      const stored: unknown = JSON.parse(w.session.map.get(PENDING_KEY) ?? "null");
      return stored === null ? [] : (stored as { e: { c: [string, string][] }[] }).e.flatMap((entry) => entry.c);
    };

    // The reviewers' probes: names and values of personal data, all of which used to be parked.
    const PROBES = [
      "no_hp=081234567890",
      "no_wa=081234567890",
      "phone_number=081234567890",
      "nama_lengkap=Budi",
      "wa_number=6281234567890",
      "access_token=abc123def",
      "otp=123456",
      "kode_otp=123456",
      "nik=3173012345670001",
      "id_number=3173012345670001",
      "card=4111111111111111",
      "card_number=4111111111111111",
      "kartu=4111-1111-1111-1111",
      "email_address=budi",
      "x=budi%40example.co",
      "contact=0812-3456-7890",
      "ref=%2B62%20812%203456%207890",
      "member=3173012345670001",
      "a_b=4111%201111%201111%201111",
      "session_id=s1",
      "auth=k",
      "pwd=x",
      "secret=x",
      "kode=x",
      "pass=x",
      "name=x",
      "mail=x",
    ];

    it.each(PROBES)("parks nothing for %s", (probe) => {
      expect(parked(`?${probe}`)).toEqual([]);
    });

    it("parks all the probes together as nothing, and keeps the click id that sits among them", () => {
      expect(parked(`?${PROBES.join("&")}&cid=zz9`)).toEqual([["cid", "zz9"]]);
    });

    it("keeps a name that only CONTAINS a personal-data word (whole words only): swap_id, shpclid, ad_wave, gwa, hpid", () => {
      expect(parked("?swap_id=ab12&shpclid=cd34&ad_wave=ef56&gwa=gh78&hpid=ij90")).toEqual([
        ["swap_id", "ab12"],
        ["shpclid", "cd34"],
        ["ad_wave", "ef56"],
        ["gwa", "gh78"],
        ["hpid", "ij90"],
      ]);
    });

    it("keeps an ordinary click-id-looking parameter, and one with digits and letters", () => {
      expect(parked("?cid=zz9&aff_click_id=AB1234567890CD&tid=12345&transaction_id=abc-123-def")).toEqual([
        ["cid", "zz9"],
        ["aff_click_id", "AB1234567890CD"],
        ["tid", "12345"],
        ["transaction_id", "abc-123-def"],
      ]);
    });

    it("drops an 8-to-16-digit value even with separators, and a phone number the normaliser accepts", () => {
      expect(parked("?a=1234-5678&b=12.345.678.901&c=1_2_3_4_5_6_7_8_9_0&d=0812345678&e=%2B6281234567890&f=12345678901234567")).toEqual([["f", "12345678901234567"]]);
    });

    it("keeps at most 6 pairs, and at most 2 KB", () => {
      const many = Array.from({ length: 20 }, (_, i) => `p${String(i)}=v${String(i)}`).join("&");
      expect(parked(`?${many}`)).toHaveLength(6);
      // The longest a pair can be (a 64-character name, a 256-character value) six times over stays under 2 KB.
      const big = Array.from({ length: 6 }, (_, i) => `${String(i)}${"n".repeat(63)}=${"x".repeat(256)}`).join("&");
      const kept = parked(`?${big}`);
      expect(kept).toHaveLength(6);
      expect(JSON.stringify(kept).length).toBeLessThanOrEqual(2048);
    });

    it("keeps nothing but plausible names, and values of up to 256 characters, token-shaped", () => {
      expect(parked(`?long=${"a".repeat(257)}&spaced=a%20b&c%20d=ok&${"n".repeat(65)}=x`)).toEqual([]);
    });

    it("ignores the keys the fixed phase already handles, and writes nothing when there are no candidates", () => {
      const w = world();
      startCapture(w.deps(), LP, "?utm_source=x&gclid=g&sub_id=s&adnet=adnet-a");
      expect(w.session.map.has(PENDING_KEY)).toBe(false);
    });

    it("never writes anything else to sessionStorage, and nothing but the click and the names to localStorage", () => {
      const w = world();
      w.load("?cid=c1&name=Budi%20Santoso&phone=081234567890&email=budi%40example.co&utm_source=fb");
      expect([...w.session.map.keys()]).toEqual([]);
      expect([...w.storage.map.keys()].sort()).toEqual([KEY, NAMES_KEY].sort());
      for (const value of w.storage.map.values()) expect(value).not.toMatch(/Budi|Santoso|081234567890|example\.co/);
    });
  });

  describe("a corrupted parked copy never throws, never yields a click, and is removed", () => {
    const entry = { t: T0, w: null, f: {}, c: [["cid", "zz9"]] };
    const good = { v: 1, e: [entry] };
    const cases: Record<string, string> = {
      "not JSON": "{oops",
      "an array": "[1]",
      "wrong version": JSON.stringify({ ...good, v: 2 }),
      "e is not a list": JSON.stringify({ v: 1, e: "cid=zz9" }),
      "no entries": JSON.stringify({ v: 1, e: [] }),
      "t is a string": JSON.stringify({ v: 1, e: [{ ...entry, t: "now" }] }),
      "c is not a list": JSON.stringify({ v: 1, e: [{ ...entry, c: "cid=zz9" }] }),
      "pairs of the wrong shape": JSON.stringify({ v: 1, e: [{ ...entry, c: [["cid"], "cid", [1, 2], ["cid", { a: 1 }]] }] }),
      "a value with a space": JSON.stringify({ v: 1, e: [{ ...entry, c: [["cid", "a b"]] }] }),
      "a bad name": JSON.stringify({ v: 1, e: [{ ...entry, c: [["c id", "zz9"]] }] }),
      "oversized": JSON.stringify({ ...good, pad: "x".repeat(20_000) }),
      "dated in the future": JSON.stringify({ v: 1, e: [{ ...entry, t: T0 + DAY }] }),
      "expired": JSON.stringify({ v: 1, e: [{ ...entry, t: T0 - PENDING_TTL_MS }] }),
      "entries that are not objects": JSON.stringify({ v: 1, e: [null, 5, "x", []] }),
    };
    it.each(Object.entries(cases))("%s", (_name, raw) => {
      const w = world();
      w.session.map.set(PENDING_KEY, raw);
      const capture = startCapture(w.deps(), LP, "");
      expect(() => {
        capture.resolve(ADNETS);
      }).not.toThrow();
      expect(capture.click()).toBeNull();
      expect(w.session.map.has(PENDING_KEY)).toBe(false);
    });

    it("removes a broken record as soon as it is read: this load parks its own entry in its place", () => {
      const w = world();
      w.session.map.set(PENDING_KEY, "{oops");
      startCapture(w.deps(), LP, "?cid=zz9");
      expect(pendingEntries(w)).toHaveLength(1);
    });

    it("keeps the entries that are still valid when another one has expired", () => {
      const w = world();
      w.session.map.set(PENDING_KEY, JSON.stringify({ v: 1, e: [{ ...entry, t: T0 - PENDING_TTL_MS }, { ...entry, t: T0 - 1000, c: [["cid", "fresh"]] }] }));
      const capture = startCapture(w.deps(), LP, "");
      capture.resolve(ADNETS);
      expect(capture.click()).toEqual({ t: T0 - 1000, a: { clickid: "fresh", adnet: "adnet-a" } });
    });

    it("ignores a hostile f (extra keys are dropped) when it resolves", () => {
      const w = world();
      w.session.map.set(PENDING_KEY, JSON.stringify({ v: 1, e: [{ ...entry, f: { phone: "0812", utm_source: "x", __proto__: { a: 1 } } }] }));
      const capture = startCapture(w.deps(), LP, "");
      capture.resolve(ADNETS);
      expect(capture.click()?.a).toEqual({ utm_source: "x", clickid: "zz9", adnet: "adnet-a" });
    });
  });
});

describe("a corrupted store never throws and never yields attribution", () => {
  const good = { v: 1, t: T0, a: { clickid: "ok" } };
  const cases: Record<string, string> = {
    "not JSON": "{oops",
    "empty string": "",
    "a number": "42",
    "null": "null",
    "an array": "[1,2]",
    "wrong version": JSON.stringify({ ...good, v: 2 }),
    "t is a string": JSON.stringify({ ...good, t: String(T0) }),
    "t is missing": JSON.stringify({ v: 1, a: { clickid: "ok" } }),
    "t is infinite": '{"v":1,"t":1e999,"a":{"clickid":"ok"}}',
    "a is a string": JSON.stringify({ ...good, a: "clickid=ok" }),
    "a is an array": JSON.stringify({ ...good, a: ["ok"] }),
    "a is empty": JSON.stringify({ ...good, a: {} }),
    "values of the wrong type": JSON.stringify({ ...good, a: { clickid: 5, gclid: { x: 1 }, utm_source: ["a"] } }),
    "a value with a space": JSON.stringify({ ...good, a: { clickid: "not ok" } }),
    "an over-long value": JSON.stringify({ ...good, a: { clickid: "a".repeat(257) } }),
    "dated in the far future": JSON.stringify({ ...good, t: T0 + 5000 * DAY }),
    "dated a minute and more ahead": JSON.stringify({ ...good, t: T0 + 2 * 60_000 }),
    "oversized": JSON.stringify({ ...good, pad: "x".repeat(20_000) }),
  };

  it.each(Object.entries(cases))("%s", (_name, raw) => {
    const w = world();
    w.storage.map.set(KEY, raw);
    expect(() => current(w.deps(), LP)).not.toThrow();
    expect(current(w.deps(), LP)).toEqual({});
    // A broken record is removed, so it cannot cost a read next time.
    expect(w.storage.map.has(KEY)).toBe(false);
  });

  it("keeps only allowlisted, well-formed keys of an otherwise valid record (no PII, no extras)", () => {
    const w = world();
    w.storage.map.set(KEY, JSON.stringify({ v: 1, t: T0, a: { clickid: "ok", phone: "0812", email: "a@b.co", name: "Budi", __proto__: { admin: true }, fbp: "fb.1.1.2", sub_id: "a b" } }));
    const out = current(w.deps(), LP);
    expect(out).toEqual({ clickid: "ok" });
    expect(Object.keys(out)).toEqual(["clickid"]);
  });

  it("accepts a click written a few seconds in the future (clock skew between tabs)", () => {
    const w = world();
    w.storage.map.set(KEY, JSON.stringify({ v: 1, t: T0 + 5000, a: { clickid: "ok" } }));
    expect(current(w.deps(), LP)).toEqual({ clickid: "ok" });
  });

  it("startCapture over a corrupted record starts clean", () => {
    const w = world();
    w.storage.map.set(KEY, "{oops");
    const capture = startCapture(w.deps(), LP, "?cid=fresh");
    capture.resolve(ADNETS);
    expect(capture.click()?.a).toEqual({ adnet: "adnet-a", clickid: "fresh" });
  });
});

describe("Meta cookies (_fbp, _fbc)", () => {
  it("sends _fbp and _fbc from the cookies, read fresh on every call", () => {
    const w = world("a=1; _fbp=fb.1.1700000000000.1234567890; _fbc=fb.1.1700000000001.AbC-def; b=2");
    expect(current(w.deps(), LP)).toEqual({ fbp: "fb.1.1700000000000.1234567890", fbc: "fb.1.1700000000001.AbC-def" });
    const later = current(w.deps({ cookie: "_fbp=fb.1.1700000000000.99" }), LP);
    expect(later).toEqual({ fbp: "fb.1.1700000000000.99" });
  });

  it("builds _fbc from the fbclid and the click time when the cookie is missing", () => {
    const w = world();
    w.load("?fbclid=IwAR_x-1");
    w.clock.now = T0 + DAY;
    expect(current(w.deps(), LP)).toEqual({ fbclid: "IwAR_x-1", fbc: `fb.1.${String(T0)}.IwAR_x-1` });
  });

  it("drops cookies that are not in Meta's format or are over-long, and survives broken encoding", () => {
    const w = world("_fbp=not-a-fbp; _fbc=fb.1.1700000000000.a b");
    expect(current(w.deps(), LP)).toEqual({});
    expect(() => current(w.deps({ cookie: "_fbp=%E0%A4%A; _fbc=%" }), LP)).not.toThrow();
    expect(current(w.deps({ cookie: `_fbc=fb.1.1700000000000.${"x".repeat(600)}` }), LP)).toEqual({});
  });

  it("readCookie finds a cookie among others, decodes it, and returns undefined for the rest", () => {
    expect(readCookie("a=1; _fbp=fb%2E1; c=3", "_fbp")).toBe("fb.1");
    expect(readCookie("a=1", "_fbp")).toBeUndefined();
    expect(readCookie("", "_fbp")).toBeUndefined();
    expect(readCookie("x_fbp=1", "_fbp")).toBeUndefined();
  });
});
