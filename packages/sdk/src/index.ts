// Entry of the landing-page SDK (an IIFE, esbuild). It is loaded by the snippet
//
//   <script src="https://api.<DOMAIN>/sdk/v1.js" data-lp="lp_..." async></script>
//
// and does, in order: capture the click that needs no config (AC-T1); read the page's config from
// the API; resolve the adnet's click id and send the visit beacon; bind every
// <form data-ebt-checkout> (form.ts), which on the first interaction loads Cap, and on submit posts
// the checkout, fires the MO pixel with the server's event id and redirects to the Midtrans Snap
// page. Nothing here throws into the host page: a failure leaves the form unbound or its error
// state shown, and the page itself keeps working. The wiring is in boot.ts, the flow in flow.ts.
import { SDK_ROUTES } from "@ebooktrivia/core/sdk-contract";
import { createApi, route } from "./api.ts";
import type { AttributionDeps, KeyValueStore } from "./attribution.ts";
import { bootTarget, pickScript, type ScriptInfo, startServices } from "./boot.ts";
import { type CapWindow, createCap } from "./cap.ts";
import { bindForm, installStyles } from "./form.ts";
import { createPixels, type Pixels, type PixelWindow } from "./pixels.ts";

declare const __CAP_FILE__: string;
declare const __CAP_WASM_FILE__: string;
declare const __CAP_HASHWX_FILE__: string;

const BOOTED = Symbol.for("ebooktrivia.sdk.booted");

const infoOf = (el: HTMLScriptElement): ScriptInfo => ({ src: el.src, dataLp: el.getAttribute("data-lp") });

/** localStorage / sessionStorage, or null when the browser blocks them (the getter itself can throw). */
function store(which: "localStorage" | "sessionStorage"): KeyValueStore | null {
  try {
    return window[which];
  } catch {
    return null;
  }
}

function boot(): void {
  const current = document.currentScript;
  const script = pickScript(
    current instanceof HTMLScriptElement ? infoOf(current) : null,
    [...document.querySelectorAll<HTMLScriptElement>("script[data-lp][src]")].map(infoOf),
  );
  const target = bootTarget(script);
  const w = window as unknown as Record<symbol, unknown>;
  if (script === null || target === null || w[BOOTED] === true) return;
  w[BOOTED] = true;
  const { lpKey, apiOrigin } = target;

  const storage = store("localStorage");
  const session = store("sessionStorage");
  const deps = (): AttributionDeps => ({ storage, session, now: () => Date.now(), cookie: document.cookie });
  const fetchImpl = (input: string, init: RequestInit): Promise<Response> => window.fetch(input, init);
  const api = createApi(apiOrigin, lpKey, fetchImpl);
  const beside = (file: string): string => new URL(file, script.src).href;
  const cap = createCap(
    window as unknown as CapWindow,
    { script: beside(__CAP_FILE__), wasm: beside(__CAP_WASM_FILE__), hashwx: beside(__CAP_HASHWX_FILE__) },
    apiOrigin + route(SDK_ROUTES.capBase, lpKey),
    fetchImpl,
  );

  let pixels: Pixels | undefined;
  const services = startServices({
    lpKey,
    apiOrigin,
    search: window.location.search,
    deps,
    api,
    cap,
    pixelsFor: (cfg) => (pixels ??= createPixels(window as unknown as PixelWindow, cfg.pixels, storage)),
    pixelsLoaded: () => pixels?.loaded() === true,
    navigate: (url) => {
      window.location.assign(url);
    },
  });

  const bind = (): void => {
    installStyles(document);
    document.querySelectorAll<HTMLFormElement>("form[data-ebt-checkout]").forEach((form, index) => {
      bindForm(form, index, services);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
}

try {
  boot();
} catch {
  // Never break the host page.
}
