// The Cap proof-of-work check (AC-S3: checkout needs a valid Cap token). The widget (@cap.js/widget,
// self-hosted next to the SDK as cap-v<version>.js) is ~56 KB, so it is NOT part of the SDK bundle:
// it is loaded on the visitor's first interaction with the checkout form and starts solving at
// once, so the proof of work runs while they type and the token is ready when they submit. A page
// that is only read never loads it, never asks the API for a challenge and never spins up workers.
//
// The widget is used headless (`new Cap(...)`, no visible element), and every request it makes is
// ours: it gets the SDK's own fetch (no cookies), and its WebAssembly modules, which it would
// fetch from a public CDN by default, are self-hosted next to it (cap-wasm-v<version>.wasm for the
// SHA-256 solver; cap-hashwx-v<version>.wasm is for the `hashwx` challenge protocol of newer Cap
// servers, which @cap.js/server 4.0.5 never issues, so it is only there so that nothing ever falls
// back to the CDN). A page whose CSP lacks 'wasm-unsafe-eval' cannot compile them: the widget then
// solves in plain JavaScript (slower, same result) and the checkout still works.
//
// Server-supplied code never runs: Cap can be asked by its server to run an "instrumentation"
// script in an iframe, which this SDK refuses to enable, as the page's visitors and money are at
// stake. @cap.js/server 4.0.5 sends none; `CAP_ISOLATE` would sandbox such a frame without
// same-origin access if one ever came, and `CAP_PAKO_URL`, the CDN fallback inflater it needs,
// is pointed at an empty data: URL, so nothing is fetched from a third party even then.
import { SDK_LIMITS } from "@ebooktrivia/core/sdk-contract";
import type { Fetch } from "./api.ts";
import type { ScriptElement } from "./pixels.ts";

interface CapInstance {
  solve(): Promise<{ success: boolean; token: string } | undefined>;
  reset(): void;
}
type CapConstructor = new (config: Record<string, string>) => CapInstance;

/** The slice of `window` Cap uses (a test passes a fake). */
export interface CapWindow {
  Cap?: CapConstructor;
  CAP_CUSTOM_FETCH?: Fetch;
  CAP_CUSTOM_WASM_URL?: string;
  CAP_CUSTOM_HASHWX_URL?: string;
  CAP_ISOLATE?: boolean;
  CAP_PAKO_URL?: string;
  CAP_SILENT?: boolean;
  CAP_DISABLE_WIDGET_REF?: boolean;
  document: { createElement(tag: "script"): ScriptElement; head: { appendChild(element: ScriptElement): unknown } };
}

/** Where the self-hosted files are (absolute URLs, next to the SDK file). */
export interface CapUrls {
  readonly script: string;
  readonly wasm: string;
  readonly hashwx: string;
}

/** A redeemed Cap token lives 20 minutes: fixed by @cap.js/server 4.0.5 (CAP_TOKEN_TTL_MS in packages/adapters). */
export const CAP_TOKEN_LIFETIME_MS = 20 * 60 * 1000;
/** A held token older than the lifetime minus this margin is not used: a fresh one is solved before submit. */
export const CAP_TOKEN_MARGIN_MS = 2 * 60 * 1000;

export interface CapSolver {
  /** Starts loading Cap and solving in the background. */
  warm(): void;
  /** A solved Cap token no older than 18 minutes, or null when Cap cannot be loaded or fails (the next call tries again). */
  token(): Promise<string | null>;
  /** The server has seen the token (and a token works once): the next `token()` solves a fresh one. */
  spent(): void;
}

export function createCap(win: CapWindow, urls: CapUrls, apiEndpoint: string, fetchImpl: Fetch, now: () => number = () => Date.now()): CapSolver {
  let loaded: Promise<CapConstructor | null> | null = null;
  let instance: CapInstance | null = null;
  let solving: Promise<string | null> | null = null;
  let solvedAt: number | null = null;

  const load = (): Promise<CapConstructor | null> => {
    loaded ??= new Promise((resolve) => {
      win.CAP_CUSTOM_FETCH = (input, init) => fetchImpl(input, { ...init, credentials: "omit", redirect: "error" });
      win.CAP_CUSTOM_WASM_URL = urls.wasm;
      win.CAP_CUSTOM_HASHWX_URL = urls.hashwx;
      win.CAP_ISOLATE = true;
      win.CAP_PAKO_URL = "data:,";
      win.CAP_SILENT = true;
      win.CAP_DISABLE_WIDGET_REF = true;
      try {
        const script = win.document.createElement("script");
        script.async = true;
        script.onload = () => {
          if (win.Cap === undefined) loaded = null;
          resolve(win.Cap ?? null);
        };
        script.onerror = () => {
          loaded = null;
          resolve(null);
        };
        script.src = urls.script;
        win.document.head.appendChild(script);
      } catch {
        loaded = null;
        resolve(null);
      }
    });
    return loaded;
  };

  const reset = (): void => {
    solving = null;
    solvedAt = null;
    try {
      instance?.reset();
    } catch {
      // Nothing to reset.
    }
  };

  const solve = (): Promise<string | null> => {
    // A token that has been held too long may be expired by the time the server sees it.
    if (solvedAt !== null && now() - solvedAt >= CAP_TOKEN_LIFETIME_MS - CAP_TOKEN_MARGIN_MS) reset();
    if (solving !== null) return solving;
    const attempt: Promise<string | null> = (async () => {
      const Cap = await load();
      if (Cap === null) return null;
      try {
        instance ??= new Cap({ apiEndpoint, "data-cap-worker-count": "4" });
        const result = await instance.solve();
        return result?.success === true && typeof result.token === "string" && result.token.length > 0 && result.token.length <= SDK_LIMITS.capToken ? result.token : null;
      } catch {
        return null;
      }
    })().then((token) => {
      // Only the attempt that is still current counts (spent() may have started a new one).
      if (solving === attempt) {
        if (token === null) solving = null;
        else solvedAt = now();
      }
      return token;
    });
    solving = attempt;
    return attempt;
  };

  return {
    warm() {
      void solve();
    },
    token: solve,
    spent: reset,
  };
}
