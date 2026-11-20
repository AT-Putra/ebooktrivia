// AC-T5: the MO pixel fires with the server's event id, at most once per order, and never blocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "./attribution.ts";
import { createPixels, FLUSH_MS, GTAG_SCRIPT, LOAD_TIMEOUT_MS, META_SCRIPT, type PixelWindow, type ScriptElement, TIKTOK_SCRIPT } from "./pixels.ts";

const EVENT_ID = "0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const IDS = { meta: "1234567890123", tiktok: "ABCDEFGH12345678", gtag: "AW-123456789" };

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

/** A window whose scripts load (or fail, or hang) as told. */
function fakeWindow(mode: "load" | "error" | "hang" = "load", seed: Partial<PixelWindow> = {}) {
  const scripts: string[] = [];
  const win: PixelWindow = {
    document: {
      createElement: (): ScriptElement => ({ src: "", async: false, onload: null, onerror: null }),
      head: {
        appendChild(el: ScriptElement) {
          scripts.push(el.src);
          if (mode === "load") queueMicrotask(() => el.onload?.());
          if (mode === "error") queueMicrotask(() => el.onerror?.());
        },
      },
    },
    ...seed,
  };
  return { win, scripts };
}

/** Runs the promise to completion under fake timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + FLUSH_MS + 10);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("nothing happens before checkout", () => {
  it("loads no script and fires nothing when no pixel is registered", async () => {
    const { win, scripts } = fakeWindow();
    const pixels = createPixels(win, {}, null);
    await settle(pixels.prepare());
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000))).toBe(false);
    expect(scripts).toEqual([]);
    expect(win.fbq).toBeUndefined();
  });

  it("reports whether the page has a pixel registered", () => {
    expect(createPixels(fakeWindow().win, {}, null).enabled).toBe(false);
    for (const ids of [{ meta: IDS.meta }, { tiktok: IDS.tiktok }, { gtag: IDS.gtag }]) expect(createPixels(fakeWindow().win, ids, null).enabled).toBe(true);
  });

  it("loaded() is false until the vendor libraries are asked to load, and stays true after (E5: they are live in the page)", async () => {
    const { win } = fakeWindow("error");
    const pixels = createPixels(win, IDS, null);
    expect(pixels.loaded()).toBe(false);
    await settle(pixels.prepare());
    expect(pixels.loaded()).toBe(true);
    expect(createPixels(fakeWindow().win, {}, null).loaded()).toBe(false);
  });

  it("creating the pixels touches nothing until prepare()", () => {
    const { win, scripts } = fakeWindow();
    createPixels(win, IDS, null);
    expect(scripts).toEqual([]);
    expect(win.fbq).toBeUndefined();
    expect(win.ttq).toBeUndefined();
    expect(win.dataLayer).toBeUndefined();
  });
});

describe("Meta", () => {
  it("loads the vendor script once, switches automatic advanced matching off before init, and tracks InitiateCheckout to the registered id with the event id", async () => {
    const { win, scripts } = fakeWindow();
    const pixels = createPixels(win, { meta: IDS.meta }, null);
    await settle(pixels.prepare());
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000))).toBe(true);
    expect(scripts).toEqual([META_SCRIPT]);
    const queue = (win.fbq as unknown as { queue: unknown[][] }).queue;
    expect(queue).toEqual([
      ["set", "autoConfig", false, IDS.meta],
      ["init", IDS.meta],
      ["trackSingle", IDS.meta, "InitiateCheckout", { value: 49000, currency: "IDR" }, { eventID: EVENT_ID }],
    ]);
  });

  it("uses the page's own fbq and loads no second copy, but still inits the registered id and addresses the event to it (C6)", async () => {
    const calls: unknown[][] = [];
    const { win, scripts } = fakeWindow("load", { fbq: Object.assign((...args: unknown[]) => calls.push(args), {}) });
    const pixels = createPixels(win, { meta: IDS.meta }, null);
    await settle(pixels.fireInitiateCheckout(EVENT_ID, 1000));
    expect(scripts).toEqual([]);
    expect(calls).toEqual([
      ["set", "autoConfig", false, IDS.meta],
      ["init", IDS.meta],
      ["trackSingle", IDS.meta, "InitiateCheckout", { value: 1000, currency: "IDR" }, { eventID: EVENT_ID }],
    ]);
  });

  it("does not init a registered id the page's own fbq already runs", async () => {
    const calls: unknown[][] = [];
    const fbq = Object.assign((...args: unknown[]) => calls.push(args), { getState: () => ({ pixels: [{ id: "999" }, { id: IDS.meta }] }) });
    const { win } = fakeWindow("load", { fbq });
    await settle(createPixels(win, { meta: IDS.meta }, null).fireInitiateCheckout(EVENT_ID, 1000));
    expect(calls.map((c) => c[0])).toEqual(["set", "trackSingle"]);
  });

  it("inits the id when the page's fbq does not know it or cannot say", async () => {
    for (const getState of [() => ({ pixels: [{ id: "999" }] }), () => undefined, () => {
      throw new Error("no state");
    }]) {
      const calls: unknown[][] = [];
      const fbq = Object.assign((...args: unknown[]) => calls.push(args), { getState });
      const { win } = fakeWindow("load", { fbq });
      await settle(createPixels(win, { meta: IDS.meta }, null).fireInitiateCheckout(OTHER_ID, 1000));
      expect(calls.map((c) => c[0])).toEqual(["set", "init", "trackSingle"]);
    }
  });
});

describe("TikTok", () => {
  it("defers InitiateCheckout with event_id on the pixel's own instance, as the vendor's snippet does, and loads the library with the pixel code", async () => {
    const { win, scripts } = fakeWindow();
    const pixels = createPixels(win, { tiktok: IDS.tiktok }, null);
    await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000));
    expect(scripts).toEqual([`${TIKTOK_SCRIPT}?sdkid=${IDS.tiktok}&lib=ttq`]);
    expect(win.TiktokAnalyticsObject).toBe("ttq");
    const instances = win.ttq?.["_i"] as Record<string, unknown[]>;
    expect([...(instances[IDS.tiktok] ?? [])]).toEqual([["track", "InitiateCheckout", { value: 49000, currency: "IDR" }, { event_id: EVENT_ID }]]);
    expect([...(win.ttq ?? [])]).toEqual([]);
  });

  it("uses the page's own ttq: loads the registered id when it never did, and tracks on that id's instance (C6)", async () => {
    const loaded: string[] = [];
    const tracked: unknown[][] = [];
    const instance = { track: (...args: unknown[]) => tracked.push(args) };
    const ttq = Object.assign([] as unknown[], { _i: { OTHERPIXEL000000: [] }, load: (id: string) => loaded.push(id), instance: (id: string) => (id === IDS.tiktok ? instance : undefined) }) as unknown as NonNullable<PixelWindow["ttq"]>;
    const { win, scripts } = fakeWindow("load", { ttq });
    await settle(createPixels(win, { tiktok: IDS.tiktok }, null).fireInitiateCheckout(EVENT_ID, 1000));
    expect(scripts).toEqual([]);
    expect(loaded).toEqual([IDS.tiktok]);
    expect(tracked).toEqual([["InitiateCheckout", { value: 1000, currency: "IDR" }, { event_id: EVENT_ID }]]);
  });

  it("does not load a registered id the page's own ttq already runs", async () => {
    const loaded: string[] = [];
    const ttq = Object.assign([] as unknown[], { _i: { [IDS.tiktok]: [] }, load: (id: string) => loaded.push(id), instance: () => ({ track: () => undefined }) }) as unknown as NonNullable<PixelWindow["ttq"]>;
    const { win } = fakeWindow("load", { ttq });
    await settle(createPixels(win, { tiktok: IDS.tiktok }, null).fireInitiateCheckout(EVENT_ID, 1000));
    expect(loaded).toEqual([]);
  });
});

describe("Google", () => {
  it("pushes gtag commands as arguments objects, as gtag.js expects, and sends begin_checkout", async () => {
    const { win, scripts } = fakeWindow();
    const pixels = createPixels(win, { gtag: IDS.gtag }, null);
    await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000));
    expect(scripts).toEqual([`${GTAG_SCRIPT}?id=${IDS.gtag}`]);
    const layer = win.dataLayer ?? [];
    expect(layer.every((entry) => Object.prototype.toString.call(entry) === "[object Arguments]")).toBe(true);
    const commands = layer.map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(commands[0]?.[0]).toBe("js");
    expect(commands[1]).toEqual(["config", IDS.gtag, { send_page_view: false }]);
    expect(commands[2]).toEqual(["event", "begin_checkout", { send_to: IDS.gtag, value: 49000, currency: "IDR" }]);
  });
});

describe("once per order", () => {
  it("fires an event id once, however often it is asked", async () => {
    const { win } = fakeWindow();
    const pixels = createPixels(win, { meta: IDS.meta }, null);
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000))).toBe(true);
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000))).toBe(false);
    const tracks = (win.fbq as unknown as { queue: unknown[][] }).queue.filter((c) => c[0] === "trackSingle");
    expect(tracks).toHaveLength(1);
  });

  it("fires two simultaneous attempts for the same order once", async () => {
    const { win } = fakeWindow();
    const pixels = createPixels(win, { meta: IDS.meta }, null);
    const both = Promise.all([pixels.fireInitiateCheckout(EVENT_ID, 1), pixels.fireInitiateCheckout(EVENT_ID, 1)]);
    expect(await settle(both)).toEqual([true, false]);
  });

  it("remembers the order across page loads (a reload, or back from the payment page)", async () => {
    const store = new MemoryStore();
    const first = fakeWindow();
    await settle(createPixels(first.win, { meta: IDS.meta }, store).fireInitiateCheckout(EVENT_ID, 49000));
    const second = fakeWindow();
    expect(await settle(createPixels(second.win, { meta: IDS.meta }, store).fireInitiateCheckout(EVENT_ID, 49000))).toBe(false);
    expect(second.win.fbq).toBeUndefined();
    // A different order is a different event.
    expect(await settle(createPixels(second.win, { meta: IDS.meta }, store).fireInitiateCheckout(OTHER_ID, 49000))).toBe(true);
    expect(JSON.parse(store.map.get("ebt:fired:1") ?? "[]")).toEqual([EVENT_ID, OTHER_ID]);
  });

  it("keeps only the newest 20 event ids", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 25; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await settle(createPixels(fakeWindow().win, { meta: IDS.meta }, store).fireInitiateCheckout(id, 1));
    }
    const ids = JSON.parse(store.map.get("ebt:fired:1") ?? "[]") as string[];
    expect(ids).toHaveLength(20);
    expect(ids.at(-1)).toBe("00000000-0000-4000-8000-000000000024");
  });

  it("refuses an event id that is not a UUID-shaped id (only the server's id is ever used)", async () => {
    const { win } = fakeWindow();
    const pixels = createPixels(win, { meta: IDS.meta }, null);
    for (const bad of ["", "order-1", "<script>", `${EVENT_ID}x`]) expect(await settle(pixels.fireInitiateCheckout(bad, 1)), bad).toBe(false);
  });

  it("survives a corrupted or blocked store", async () => {
    const corrupted = new MemoryStore();
    corrupted.map.set("ebt:fired:1", "{not json");
    expect(await settle(createPixels(fakeWindow().win, { meta: IDS.meta }, corrupted).fireInitiateCheckout(EVENT_ID, 1))).toBe(true);
    const junk = new MemoryStore();
    junk.map.set("ebt:fired:1", JSON.stringify([5, null, { a: 1 }, EVENT_ID, "x"]));
    expect(await settle(createPixels(fakeWindow().win, { meta: IDS.meta }, junk).fireInitiateCheckout(EVENT_ID, 1))).toBe(false);
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const pixels = createPixels(fakeWindow().win, { meta: IDS.meta }, blocked);
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 1))).toBe(true);
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 1))).toBe(false);
  });
});

describe("a vendor never blocks the payment", () => {
  it("carries on when a script fails to load (an ad blocker)", async () => {
    const { win } = fakeWindow("error");
    const pixels = createPixels(win, IDS, null);
    expect(await settle(pixels.fireInitiateCheckout(EVENT_ID, 49000))).toBe(true);
  });

  it("gives up waiting for a script that never loads after the load timeout", async () => {
    const { win } = fakeWindow("hang");
    const pixels = createPixels(win, IDS, null);
    let done = false;
    void pixels.fireInitiateCheckout(EVENT_ID, 49000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1 + FLUSH_MS);
    expect(done).toBe(true);
  });

  it("carries on when the document refuses a script, or a vendor function throws", async () => {
    const refusing = fakeWindow();
    refusing.win.document.head.appendChild = () => {
      throw new Error("blocked by CSP");
    };
    expect(await settle(createPixels(refusing.win, IDS, null).fireInitiateCheckout(EVENT_ID, 1))).toBe(true);
    const throwing = fakeWindow("load", {
      fbq: () => {
        throw new Error("vendor bug");
      },
    });
    expect(await settle(createPixels(throwing.win, { meta: IDS.meta }, null).fireInitiateCheckout(OTHER_ID, 1))).toBe(true);
  });
});
