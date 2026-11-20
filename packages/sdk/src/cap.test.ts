// Cap is loaded lazily and used headless, from files on the API's own origin; a token works once and
// goes stale.
import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./api.ts";
import { CAP_TOKEN_LIFETIME_MS, CAP_TOKEN_MARGIN_MS, type CapUrls, type CapWindow, createCap } from "./cap.ts";
import type { ScriptElement } from "./pixels.ts";

const URLS: CapUrls = {
  script: "https://api.example.test/sdk/cap-v0.1.62.js",
  wasm: "https://api.example.test/sdk/cap-wasm-v0.0.8.wasm",
  hashwx: "https://api.example.test/sdk/cap-hashwx-v0.0.8.wasm",
};
const ENDPOINT = "https://api.example.test/api/v1/cap/lp_Abcdefgh12345678abcdefgh/";

interface FakeCap {
  config: Record<string, string>;
  solve: () => Promise<{ success: boolean; token: string } | undefined>;
  reset: () => void;
}

/** A window whose Cap script defines `Cap` when it loads. */
function setup(options: { script?: "load" | "error"; solve?: () => Promise<{ success: boolean; token: string } | undefined>; now?: () => number } = {}) {
  const loaded: string[] = [];
  const instances: FakeCap[] = [];
  let tokens = 0;
  const win: CapWindow = {
    document: {
      createElement: (): ScriptElement => ({ src: "", async: false, onload: null, onerror: null }),
      head: {
        appendChild(el: ScriptElement) {
          loaded.push(el.src);
          queueMicrotask(() => {
            if ((options.script ?? "load") === "error") {
              el.onerror?.();
              return;
            }
            win.Cap = class {
              readonly config: Record<string, string>;
              constructor(config: Record<string, string>) {
                this.config = config;
                instances.push(this);
              }
              solve = options.solve ?? (() => Promise.resolve({ success: true, token: `token-${String((tokens += 1))}` }));
              reset = vi.fn();
            };
            el.onload?.();
          });
        },
      },
    },
  };
  const fetched: { url: string; init: RequestInit }[] = [];
  const fetchImpl: Fetch = (url, init) => {
    fetched.push({ url, init });
    return Promise.resolve(new Response("{}"));
  };
  return { win, loaded, instances, fetched, cap: createCap(win, URLS, ENDPOINT, fetchImpl, options.now) };
}

describe("lazy loading", () => {
  it("loads nothing until the first interaction", () => {
    const { win, loaded } = setup();
    expect(loaded).toEqual([]);
    expect(win.Cap).toBeUndefined();
    expect(win.CAP_CUSTOM_WASM_URL).toBeUndefined();
  });

  it("warm() loads the self-hosted widget once and mounts it on the API's Cap endpoint", async () => {
    const { cap, loaded, instances } = setup();
    cap.warm();
    cap.warm();
    expect(await cap.token()).toBe("token-1");
    expect(loaded).toEqual([URLS.script]);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.config).toMatchObject({ apiEndpoint: ENDPOINT });
  });

  it("with no warm-up, token() loads and solves on demand", async () => {
    const { cap, loaded } = setup();
    expect(await cap.token()).toBe("token-1");
    expect(loaded).toEqual([URLS.script]);
  });
});

describe("every file is ours, no cookies, no code from the server", () => {
  it("points the widget's WebAssembly solvers at the self-hosted files, never at a CDN (owner decision O1)", async () => {
    const { win, cap } = setup();
    await cap.token();
    expect(win.CAP_CUSTOM_WASM_URL).toBe(URLS.wasm);
    expect(win.CAP_CUSTOM_HASHWX_URL).toBe(URLS.hashwx);
    for (const url of [win.CAP_CUSTOM_WASM_URL, win.CAP_CUSTOM_HASHWX_URL, win.CAP_PAKO_URL]) expect(url).not.toMatch(/jsdelivr|unpkg|cdnjs/);
  });

  it("uses the SDK's own fetch without credentials", async () => {
    const { win, cap, fetched } = setup();
    await cap.token();
    await win.CAP_CUSTOM_FETCH?.(`${ENDPOINT}challenge`, { method: "POST", credentials: "include", redirect: "follow" });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toBe(`${ENDPOINT}challenge`);
    expect(fetched[0]?.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
  });

  it("never runs instrumentation a server would send: the isolation flag is on and the inflater fallback is an empty data: URL (security review S3)", async () => {
    const { win, cap } = setup();
    expect(win.CAP_ISOLATE).toBeUndefined();
    await cap.token();
    // CAP_ISOLATE sandboxes an instrumentation frame without same-origin access; CAP_PAKO_URL, which that
    // frame's inflater would be loaded from, points at nothing. @cap.js/server 4.0.5 sends none at all.
    expect(win.CAP_ISOLATE).toBe(true);
    expect(win.CAP_PAKO_URL).toBe("data:,");
    expect(win.CAP_SILENT).toBe(true);
    expect(win.CAP_DISABLE_WIDGET_REF).toBe(true);
  });
});

describe("tokens", () => {
  it("shares one solve between callers", async () => {
    const solve = vi.fn(() => Promise.resolve({ success: true, token: "shared" }));
    const { cap } = setup({ solve });
    const [a, b] = await Promise.all([cap.token(), cap.token()]);
    expect([a, b]).toEqual(["shared", "shared"]);
    expect(solve).toHaveBeenCalledTimes(1);
  });

  it("solves a fresh token after the server has seen the previous one", async () => {
    const { cap, instances } = setup();
    expect(await cap.token()).toBe("token-1");
    expect(await cap.token()).toBe("token-1");
    cap.spent();
    expect(await cap.token()).toBe("token-2");
    expect(instances).toHaveLength(1);
  });

  it("is null, and tries again next time, when the script cannot be loaded", async () => {
    const failing = setup({ script: "error" });
    expect(await failing.cap.token()).toBeNull();
    expect(await failing.cap.token()).toBeNull();
    expect(failing.loaded).toHaveLength(2);
  });

  it("is null when solving fails, is refused or returns something odd", async () => {
    for (const result of [() => Promise.reject(new Error("solve_failed")), () => Promise.resolve({ success: false, token: "x" }), () => Promise.resolve(undefined), () => Promise.resolve({ success: true, token: "" }), () => Promise.resolve({ success: true, token: "t".repeat(257) })]) {
      const { cap } = setup({ solve: result });
      expect(await cap.token()).toBeNull();
    }
  });

  it("retries a failed solve with the next call", async () => {
    let calls = 0;
    const { cap } = setup({ solve: () => (++calls === 1 ? Promise.reject(new Error("network_error")) : Promise.resolve({ success: true, token: "second" })) });
    expect(await cap.token()).toBeNull();
    expect(await cap.token()).toBe("second");
  });

  it("spent() before anything loaded is harmless", () => {
    expect(() => {
      setup().cap.spent();
    }).not.toThrow();
  });

  it("a spent() while a solve is in flight is not undone by that solve finishing", async () => {
    let finish: (value: { success: boolean; token: string }) => void = () => undefined;
    const pending = new Promise<{ success: boolean; token: string }>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const { cap } = setup({ solve: () => (++calls === 1 ? pending : Promise.resolve({ success: true, token: "fresh" })) });
    const first = cap.token();
    await Promise.resolve();
    await Promise.resolve();
    cap.spent();
    expect(await cap.token()).toBe("fresh");
    finish({ success: true, token: "stale" });
    expect(await first).toBe("stale");
    expect(await cap.token()).toBe("fresh");
  });
});

describe("a held token goes stale before the server's 20 minutes are up (C7)", () => {
  it("uses a token up to 18 minutes old and solves a fresh one after that", async () => {
    expect(CAP_TOKEN_LIFETIME_MS).toBe(20 * 60 * 1000);
    expect(CAP_TOKEN_MARGIN_MS).toBe(2 * 60 * 1000);
    const clock = { now: 1_000_000 };
    const { cap, instances } = setup({ now: () => clock.now });
    expect(await cap.token()).toBe("token-1");
    clock.now += CAP_TOKEN_LIFETIME_MS - CAP_TOKEN_MARGIN_MS - 1;
    expect(await cap.token()).toBe("token-1");
    clock.now += 1;
    expect(await cap.token()).toBe("token-2");
    expect(instances[0]?.reset).toHaveBeenCalledTimes(1);
    // The fresh token is timed from when it was solved.
    clock.now += 60_000;
    expect(await cap.token()).toBe("token-2");
  });

  it("warm-up then a long wait before submit still gives a fresh token", async () => {
    const clock = { now: 0 };
    const { cap } = setup({ now: () => clock.now });
    cap.warm();
    await cap.token();
    clock.now += 19 * 60 * 1000;
    expect(await cap.token()).toBe("token-2");
  });
});
