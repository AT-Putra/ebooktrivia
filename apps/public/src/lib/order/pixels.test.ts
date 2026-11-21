// AC-T5: the MT pixel fires Purchase with the pixel contract's event_id and transaction_id, to the
// registered ids only, loads nothing for a vendor without an id, and never blocks or breaks the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firePurchase, FLUSH_MS, GTAG_SCRIPT, LOAD_TIMEOUT_MS, META_SCRIPT, type PixelWindow, type PurchaseEvent, type ScriptElement, TIKTOK_SCRIPT } from "./pixels.ts";

const EVENT_ID = "0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f";
const ORDER_ID = "7c0d8c1e-6f43-4a0e-8f3b-2e8a4d9a1b77";
const ALL = { meta: "1234567890123", tiktok: "ABCDEFGH12345678", gtag: "AW-123456789", gtag_label: "AbC_12-xyz" };
const event = (pixels: PurchaseEvent["pixels"]): PurchaseEvent => ({ eventId: EVENT_ID, transactionId: ORDER_ID, valueIdr: 49_000, pixels });

function fakeWindow(mode: "load" | "error" | "hang" = "load") {
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
  };
  return { win, scripts };
}

async function run(promise: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + FLUSH_MS + 10);
  await promise;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("firePurchase", () => {
  it("loads nothing and fires nothing for a landing page without a usable pixel", async () => {
    const { win, scripts } = fakeWindow();
    await run(firePurchase(win, event({})));
    await run(firePurchase(win, event({ gtag: ALL.gtag })));
    expect(scripts).toEqual([]);
    expect(win.fbq).toBeUndefined();
    expect(win.ttq).toBeUndefined();
    expect(win.dataLayer).toBeUndefined();
  });

  it("Meta: switches automatic advanced matching off before init, then tracks Purchase to the registered id with the event id", async () => {
    const { win, scripts } = fakeWindow();
    await run(firePurchase(win, event({ meta: ALL.meta })));
    expect(scripts).toEqual([META_SCRIPT]);
    const queue = (win.fbq?.queue ?? []).map((args) => [...args]);
    expect(queue).toEqual([
      ["set", "autoConfig", false, ALL.meta],
      ["init", ALL.meta],
      ["trackSingle", ALL.meta, "Purchase", { value: 49_000, currency: "IDR" }, { eventID: EVENT_ID }],
    ]);
  });

  it("TikTok: tracks CompletePayment on the registered instance with the event id", async () => {
    const { win, scripts } = fakeWindow();
    await run(firePurchase(win, event({ tiktok: ALL.tiktok })));
    expect(scripts).toEqual([`${TIKTOK_SCRIPT}?sdkid=${ALL.tiktok}&lib=ttq`]);
    const instance = (win.ttq?.["_i"] as Record<string, unknown[]>)[ALL.tiktok];
    expect(instance).toBeDefined();
    expect(instance?.map((call) => [...(call as unknown[])])).toEqual([["track", "CompletePayment", { value: 49_000, currency: "IDR" }, { event_id: EVENT_ID }]]);
  });

  it("Google Ads: a conversion event to AW-id/label with the order as the transaction id, no page view", async () => {
    const { win, scripts } = fakeWindow();
    await run(firePurchase(win, event({ gtag: ALL.gtag, gtag_label: ALL.gtag_label })));
    expect(scripts).toEqual([`${GTAG_SCRIPT}?id=${ALL.gtag}`]);
    const layer = (win.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(layer.slice(1)).toEqual([
      ["config", ALL.gtag, { send_page_view: false }],
      ["event", "conversion", { send_to: `${ALL.gtag}/${ALL.gtag_label}`, value: 49_000, currency: "IDR", transaction_id: ORDER_ID }],
    ]);
    expect(layer[0]?.[0]).toBe("js");
  });

  it("fires all registered vendors, each library once, and nothing personal anywhere", async () => {
    const { win, scripts } = fakeWindow();
    await run(firePurchase(win, event(ALL)));
    expect(scripts).toHaveLength(3);
    const sent = JSON.stringify([win.fbq?.queue, win.dataLayer, win.ttq?.["_i"]]);
    expect(sent).toContain(EVENT_ID);
    expect(sent).not.toMatch(/@|\+62|email|phone|name/i);
  });

  it("is bounded when a library hangs, and survives one that fails to load", async () => {
    for (const mode of ["hang", "error"] as const) {
      const { win } = fakeWindow(mode);
      let done = false;
      const promise = firePurchase(win, event(ALL)).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + FLUSH_MS + 10);
      await promise;
      expect(done, mode).toBe(true);
      expect(win.fbq?.queue?.some((args) => args[0] === "trackSingle"), mode).toBe(true);
    }
  });

  it("fires TikTok and Google even when Meta's library throws on the call", async () => {
    const { win } = fakeWindow();
    const append = win.document.head.appendChild.bind(win.document.head);
    win.document.head.appendChild = (el: ScriptElement) => {
      // Meta's library arrives and replaces the stub's dispatcher with one that throws.
      if (el.src === META_SCRIPT && win.fbq !== undefined) {
        win.fbq.callMethod = () => {
          throw new Error("fbq is broken");
        };
      }
      return append(el);
    };
    await run(firePurchase(win, event(ALL)));
    expect(Array.from(win.ttq?.["_i"] ? ((win.ttq["_i"] as Record<string, unknown[]>)[ALL.tiktok] ?? []) : [])).toHaveLength(1);
    const layer = (win.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(layer.filter((entry) => entry[0] === "event")).toHaveLength(1);
  });

  it("does not throw when a vendor's own code does", async () => {
    const { win } = fakeWindow();
    const broken: PixelWindow = {
      ...win,
      document: {
        createElement: () => {
          throw new Error("blocked");
        },
        head: win.document.head,
      },
    };
    await expect(run(firePurchase(broken, event(ALL)))).resolves.toBeUndefined();
  });
});
