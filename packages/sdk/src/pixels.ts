// Browser pixels of the landing page (AC-T5): the MO event, InitiateCheckout or the platform's
// equivalent, fired with the `event_id` the server returned so the server-side conversion (Meta
// CAPI, TikTok Events API) dedupes against it. The ids come from the page's registered config.
//
//   - Nothing is loaded or fired before checkout has succeeded, so no vendor script runs on a
//     visitor who has not ticked the consent box (UU PDP), and none ever sees the form's values:
//     the caller clears them first (flow.ts), because the vendors' automatic advanced matching
//     scrapes e-mail and phone fields from the DOM. Meta's is also switched off here
//     (`fbq('set', 'autoConfig', false, id)` before `init`). TikTok has NO client-side switch: its
//     loader takes the pixel's plugin configuration (AutoAdvancedMatching) from the account, so that
//     one is an Owner step in TikTok Events Manager (docs/runbooks/landing-page-pixels.md).
//   - The vendor libraries load in parallel with each other; a vendor that is blocked or slow never
//     blocks the payment (bounded wait).
//   - Each pixel fires at most once per order: an event id is claimed in memory and in localStorage
//     (ids only, random and not personal) before anything is sent.
//   - If the page already runs a vendor's own base code (window.fbq, window.ttq, window.gtag), the
//     SDK uses it instead of loading a second copy, but still makes sure the REGISTERED id is
//     initialised and addresses the event to that id only (Meta `trackSingle`, TikTok
//     `ttq.instance(id)`), so it reaches the registered pixel and not just whichever ones the page set up.
import { SDK_PATTERNS, type SdkLpConfig } from "@ebooktrivia/core/sdk-contract";
import type { KeyValueStore } from "./attribution.ts";

export type PixelIds = SdkLpConfig["pixels"];

type Args = readonly unknown[];
interface FbqStub {
  (...args: Args): void;
  queue?: Args[];
  push?: unknown;
  loaded?: boolean;
  version?: string;
  callMethod?: (...args: Args) => void;
  /** The real library's state; a page's own fbq may expose it. */
  getState?: () => { pixels?: readonly { id?: unknown }[] } | undefined;
}
interface TtqStub extends Array<unknown> {
  [method: string]: unknown;
}
export interface ScriptElement {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}
/** The slice of `window` the pixels touch (a test passes a fake). */
export interface PixelWindow {
  fbq?: FbqStub;
  _fbq?: unknown;
  ttq?: TtqStub;
  TiktokAnalyticsObject?: string;
  dataLayer?: unknown[];
  gtag?: (...args: Args) => void;
  document: { createElement(tag: "script"): ScriptElement; head: { appendChild(element: ScriptElement): unknown } };
}

export const META_SCRIPT = "https://connect.facebook.net/en_US/fbevents.js";
export const TIKTOK_SCRIPT = "https://analytics.tiktok.com/i18n/pixel/events.js";
export const GTAG_SCRIPT = "https://www.googletagmanager.com/gtag/js";

/** How long the vendor libraries get to load, and how long they get to send after the event. */
export const LOAD_TIMEOUT_MS = 2500;
export const FLUSH_MS = 300;

const TTQ_METHODS = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"];

const FIRED_KEY = "ebt:fired:1";
const FIRED_KEEP = 20;
const EVENT_ID = new RegExp(SDK_PATTERNS.uuid);

export interface Pixels {
  /** True when the page has a pixel registered (nothing is loaded or fired otherwise). */
  readonly enabled: boolean;
  /** True once the vendor libraries have been asked to load (they stay live in this page until it is left). */
  loaded(): boolean;
  /** Installs the vendor stubs and starts loading the libraries; resolves when they loaded, failed or timed out. */
  prepare(): Promise<void>;
  /** Fires the MO event once per `eventId`; resolves after the flush delay. Returns false when it already fired. */
  fireInitiateCheckout(eventId: string, valueIdr: number): Promise<boolean>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createPixels(win: PixelWindow, ids: PixelIds, storage: KeyValueStore | null): Pixels {
  const fired = new Set<string>();
  let prepared: Promise<void> | null = null;
  const enabled = ids.meta !== undefined || ids.tiktok !== undefined || ids.gtag !== undefined;

  const inject = (src: string): Promise<void> =>
    new Promise((resolve) => {
      try {
        const script = win.document.createElement("script");
        script.async = true;
        script.onload = () => {
          resolve();
        };
        script.onerror = () => {
          resolve();
        };
        script.src = src;
        win.document.head.appendChild(script);
      } catch {
        resolve();
      }
    });

  function installMeta(id: string): Promise<void> {
    let load = Promise.resolve();
    if (typeof win.fbq !== "function") {
      const stub = ((...args: Args) => {
        if (stub.callMethod === undefined) stub.queue?.push(args);
        else stub.callMethod(...args);
      }) as FbqStub;
      stub.push = stub;
      stub.loaded = true;
      stub.version = "2.0";
      stub.queue = [];
      win.fbq = stub;
      win._fbq = stub;
      load = inject(META_SCRIPT);
    }
    const fbq = win.fbq;
    if (typeof fbq !== "function") return load;
    // Automatic advanced matching (it reads e-mail and phone fields from the page) off, before init.
    fbq("set", "autoConfig", false, id);
    let known = false;
    try {
      known = fbq.getState?.()?.pixels?.some((p) => String(p.id) === id) === true;
    } catch {
      // The page's own fbq does not expose its state: init the id.
    }
    if (!known) fbq("init", id);
    return load;
  }

  function installTiktok(id: string): Promise<void> {
    const own = win.ttq;
    if (own !== undefined) {
      // The page's own base code: load the registered id too when it never did.
      const known = (own["_i"] as Record<string, unknown> | undefined)?.[id] !== undefined;
      if (!known && typeof own["load"] === "function") (own["load"] as (id: string) => void)(id);
      return Promise.resolve();
    }
    const ttq = [] as unknown as TtqStub;
    win.TiktokAnalyticsObject = "ttq";
    win.ttq = ttq;
    for (const method of TTQ_METHODS) ttq[method] = (...args: Args) => ttq.push([method, ...args]);
    const instances: Record<string, TtqStub> = { [id]: Object.assign([], { _u: TIKTOK_SCRIPT }) as unknown as TtqStub };
    ttq["_i"] = instances;
    ttq["_t"] = { [id]: Date.now() };
    ttq["_o"] = { [id]: {} };
    // As the vendor's own snippet: an instance defers its calls on the pixel's own queue.
    ttq["instance"] = (pixelId: string): TtqStub => {
      const instance = instances[pixelId] ?? ([] as unknown as TtqStub);
      for (const method of TTQ_METHODS) instance[method] = (...args: Args) => instance.push([method, ...args]);
      return instance;
    };
    return inject(`${TIKTOK_SCRIPT}?sdkid=${encodeURIComponent(id)}&lib=ttq`);
  }

  function installGtag(id: string): Promise<void> {
    const own = win.gtag === undefined;
    win.dataLayer = win.dataLayer ?? [];
    const layer = win.dataLayer;
    if (own) {
      // gtag.js tells commands from data by their type: the dataLayer must receive the `arguments`
      // object, as Google's own snippet pushes it, not an array.
      win.gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        layer.push(arguments);
      };
      win.gtag("js", new Date());
    }
    win.gtag?.("config", id, { send_page_view: false });
    return own ? inject(`${GTAG_SCRIPT}?id=${encodeURIComponent(id)}`) : Promise.resolve();
  }

  const claim = (eventId: string): boolean => {
    if (!EVENT_ID.test(eventId) || fired.has(eventId)) return false;
    fired.add(eventId);
    try {
      const raw = storage?.getItem(FIRED_KEY);
      const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && EVENT_ID.test(x)) : [];
      if (list.includes(eventId)) return false;
      storage?.setItem(FIRED_KEY, JSON.stringify([...list, eventId].slice(-FIRED_KEEP)));
    } catch {
      // Storage blocked or corrupted: the in-memory claim still stops a second fire on this page.
    }
    return true;
  };

  /** A vendor function that throws (a page's own broken fbq, say) must not stop the others or the payment. */
  const attempt = (install: () => Promise<void>): Promise<void> => {
    try {
      return install();
    } catch {
      return Promise.resolve();
    }
  };

  const prepare = (): Promise<void> => {
    prepared ??= (async () => {
      const loads: Promise<void>[] = [];
      if (ids.meta !== undefined) loads.push(attempt(() => installMeta(ids.meta as string)));
      if (ids.tiktok !== undefined) loads.push(attempt(() => installTiktok(ids.tiktok as string)));
      if (ids.gtag !== undefined) loads.push(attempt(() => installGtag(ids.gtag as string)));
      if (loads.length > 0) await Promise.race([Promise.all(loads), delay(LOAD_TIMEOUT_MS)]);
    })();
    return prepared;
  };

  return {
    enabled,
    loaded: () => prepared !== null,
    prepare,
    async fireInitiateCheckout(eventId, valueIdr) {
      if (!enabled || !claim(eventId)) return false;
      await prepare();
      const value = valueIdr;
      try {
        if (ids.meta !== undefined && typeof win.fbq === "function") win.fbq("trackSingle", ids.meta, "InitiateCheckout", { value, currency: "IDR" }, { eventID: eventId });
        if (ids.tiktok !== undefined) {
          const instance = (win.ttq?.["instance"] as ((id: string) => TtqStub | undefined) | undefined)?.(ids.tiktok);
          (instance?.["track"] as ((...args: Args) => void) | undefined)?.("InitiateCheckout", { value, currency: "IDR" }, { event_id: eventId });
        }
        if (ids.gtag !== undefined) win.gtag?.("event", "begin_checkout", { send_to: ids.gtag, value, currency: "IDR" });
      } catch {
        // A vendor script that throws must not stop the payment redirect.
      }
      await delay(FLUSH_MS);
      return true;
    },
  };
}
