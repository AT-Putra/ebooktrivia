// The browser MT pixels of the order page (AC-T5): Purchase, or the vendor's equivalent, fired once the
// exactly-once claim (claim_browser_mt) has been won. Same pattern as the SDK's MO pixel
// (packages/sdk/src/pixels.ts): the page's own script installs each vendor's stub and loads its library
// from the host the CSP allows for THIS landing page (csp.ts); nothing is loaded before the claim.
//
//   - The pixel contract (plan M7, US-021): event_id = orders.event_id, so Meta and TikTok dedupe this event
//     against the server-side one (CAPI / Events API); transaction_id = orders.id, which Google Ads takes
//     as the conversion's own id and which is the {txid} the adnets get.
//   - Nothing personal is sent: no e-mail, no phone, no name. Meta's automatic advanced matching is switched
//     off before `init` (the page has no form to read anyway). TikTok has no client-side switch
//     (docs/runbooks/landing-page-pixels.md, an Owner step).
//   - Events: Meta `Purchase`; TikTok `CompletePayment` (TikTok's standard purchase event, what its Events
//     API calls it too, so the shared event_id dedupes); Google Ads a `conversion` event to
//     send_to = AW-id/label (the id and the label the Owner registered).
//   - A vendor that is blocked, slow or throws never stops the others or the page: the libraries get a
//     bounded time to load, and every call is guarded.
import type { PixelIds } from "./vendors.ts";

type Args = readonly unknown[];
interface FbqStub {
  (...args: Args): void;
  queue?: Args[];
  push?: unknown;
  loaded?: boolean;
  version?: string;
  callMethod?: (...args: Args) => void;
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

export interface PurchaseEvent {
  readonly eventId: string;
  readonly transactionId: string;
  readonly valueIdr: number;
  readonly pixels: PixelIds;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function inject(win: PixelWindow, src: string): Promise<void> {
  return new Promise((resolve) => {
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
}

function installMeta(win: PixelWindow, id: string): Promise<void> {
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
  // Automatic advanced matching off, before init.
  stub("set", "autoConfig", false, id);
  stub("init", id);
  return inject(win, META_SCRIPT);
}

function installTiktok(win: PixelWindow, id: string): Promise<void> {
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
  return inject(win, `${TIKTOK_SCRIPT}?sdkid=${encodeURIComponent(id)}&lib=ttq`);
}

function installGtag(win: PixelWindow, id: string): Promise<void> {
  const layer = (win.dataLayer ??= []);
  // gtag.js tells commands from data by their type: the dataLayer must receive the `arguments` object,
  // as Google's own snippet pushes it, not an array.
  win.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    layer.push(arguments);
  };
  win.gtag("js", new Date());
  win.gtag("config", id, { send_page_view: false });
  return inject(win, `${GTAG_SCRIPT}?id=${encodeURIComponent(id)}`);
}

/** One vendor's call: a library that throws (a broken or hostile fbq) must not stop the others. */
function guarded(call: () => void): void {
  try {
    call();
  } catch {
    // The vendor's problem, not the page's.
  }
}

/** A vendor that throws while it is installed (a blocked or broken library) must not stop the others. */
function attempt(install: () => Promise<void>): Promise<void> {
  try {
    return install();
  } catch {
    return Promise.resolve();
  }
}

/**
 * Installs the vendors that have an id, waits (bounded) for their libraries, fires the Purchase event to
 * the registered ids only, and waits a moment for the libraries to send it. Call it at most once per
 * claim; it resolves when it is done and never rejects.
 */
export async function firePurchase(win: PixelWindow, event: PurchaseEvent): Promise<void> {
  const { pixels, eventId, transactionId, valueIdr } = event;
  const loads: Promise<void>[] = [];
  if (pixels.meta !== undefined) loads.push(attempt(() => installMeta(win, pixels.meta as string)));
  if (pixels.tiktok !== undefined) loads.push(attempt(() => installTiktok(win, pixels.tiktok as string)));
  if (pixels.gtag !== undefined && pixels.gtag_label !== undefined) loads.push(attempt(() => installGtag(win, pixels.gtag as string)));
  if (loads.length === 0) return;
  await Promise.race([Promise.all(loads), delay(LOAD_TIMEOUT_MS)]);
  const { meta, tiktok, gtag, gtag_label: label } = pixels;
  if (meta !== undefined) {
    guarded(() => {
      if (typeof win.fbq === "function") win.fbq("trackSingle", meta, "Purchase", { value: valueIdr, currency: "IDR" }, { eventID: eventId });
    });
  }
  if (tiktok !== undefined) {
    guarded(() => {
      const instance = (win.ttq?.["instance"] as ((id: string) => TtqStub | undefined) | undefined)?.(tiktok);
      (instance?.["track"] as ((...args: Args) => void) | undefined)?.("CompletePayment", { value: valueIdr, currency: "IDR" }, { event_id: eventId });
    });
  }
  if (gtag !== undefined && label !== undefined) {
    guarded(() => {
      win.gtag?.("event", "conversion", { send_to: `${gtag}/${label}`, value: valueIdr, currency: "IDR", transaction_id: transactionId });
    });
  }
  await delay(FLUSH_MS);
}
