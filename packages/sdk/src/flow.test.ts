// The checkout flow without a DOM: the order of what happens, every not-ready state, the consent,
// error mapping, the redirect guard, and the one-order-at-a-time guard of the form.
import type { SdkCheckoutRequest, SdkFieldErrors, SdkLpConfig } from "@ebooktrivia/core/sdk-contract";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutResult } from "./api.ts";
import { createSubmitGuard, type FlowView, restoredFromCache, runCheckout, type Services } from "./flow.ts";
import { text } from "./messages.ts";
import type { Pixels } from "./pixels.ts";
import type { FormValues } from "./validate.ts";

const EVENT_ID = "0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f";
const VISIT_ID = "11111111-2222-4333-8444-555555555555";
const SNAP = "https://app.sandbox.midtrans.com/snap/v4/redirection/66e4fa55-fdac-4ef9-91b5-733b97d1b862";
const CONFIG: SdkLpConfig = {
  v: 1,
  lp_key: "lp_Abcdefgh12345678abcdefgh",
  checkout_open: true,
  adnets: [],
  pixels: { meta: "1234567890123" },
  midtrans_env: "sandbox",
  legal: { play_origin: "https://play.example.test", program: "juni-2026", terms: 3, privacy: 2 },
};
const GOOD: FormValues = { name: "Budi Santoso", phone: "0812-3456-7890", email: "budi@example.co", consent: true };

interface Options {
  config?: SdkLpConfig | null;
  values?: FormValues;
  incomplete?: boolean;
  capToken?: string | null;
  checkout?: CheckoutResult;
  pixelsEnabled?: boolean;
  apiOrigin?: string;
}

function harness(options: Options = {}) {
  const events: string[] = [];
  const requests: Omit<SdkCheckoutRequest, "v">[] = [];
  const fieldErrors: SdkFieldErrors[] = [];
  const formErrors: string[] = [];
  const pixels: Pixels = {
    enabled: options.pixelsEnabled ?? true,
    loaded: () => false,
    prepare: () => {
      events.push("prepare");
      return Promise.resolve();
    },
    fireInitiateCheckout: (eventId, value) => {
      events.push(`fire:${eventId}:${String(value)}`);
      return Promise.resolve(true);
    },
  };
  const svc: Services = {
    config: Promise.resolve(options.config === undefined ? CONFIG : options.config),
    apiOrigin: options.apiOrigin ?? "https://api.example.test",
    attribution: () => ({ clickid: "c1", adnet: "adnet-a" }),
    visitId: () => VISIT_ID,
    api: {
      config: () => Promise.resolve(null),
      visit: () => Promise.resolve(null),
      checkout: (request) => {
        events.push("checkout");
        requests.push(request);
        return Promise.resolve(options.checkout ?? { ok: true, response: { v: 1, event_id: EVENT_ID, snap_redirect_url: SNAP, value_idr: 49000, deduped: false } });
      },
    },
    cap: {
      warm: () => undefined,
      token: () => {
        events.push("token");
        return Promise.resolve(options.capToken === undefined ? "cap-token" : options.capToken);
      },
      spent: () => {
        events.push("spent");
      },
    },
    pixelsFor: () => pixels,
    pixelsLoaded: () => false,
    navigate: (url) => {
      events.push(`navigate:${url}`);
    },
  };
  const view: FlowView = {
    incomplete: () => options.incomplete ?? false,
    read: () => options.values ?? GOOD,
    fieldErrors: (errors) => {
      fieldErrors.push(errors);
    },
    formError: (message) => {
      formErrors.push(message);
    },
    clearPersonalData: () => {
      events.push("clear");
    },
  };
  return { svc, view, events, requests, fieldErrors, formErrors };
}

describe("a successful checkout", () => {
  it("posts the payload, clears the visitor's values BEFORE any vendor script can load, fires the MO pixel with the server's event id, then navigates (owner decision O3)", async () => {
    const h = harness();
    expect(await runCheckout(h.svc, h.view)).toBe(true);
    expect(h.events).toEqual(["token", "checkout", "spent", "clear", `fire:${EVENT_ID}:49000`, `navigate:${SNAP}`]);
    // The flow never asks the pixels to prepare (load vendor scripts) itself: only firing does, after the clear.
    expect(h.events.indexOf("prepare")).toBe(-1);
    expect(h.requests).toEqual([
      {
        name: "Budi Santoso",
        phone: "+6281234567890",
        email: "budi@example.co",
        cap_token: "cap-token",
        consent: { terms: 3, privacy: 2 },
        attribution: { clickid: "c1", adnet: "adnet-a" },
        visit_id: VISIT_ID,
      },
    ]);
    expect(h.formErrors).toEqual([]);
  });

  it("omits visit_id when the visit beacon did not answer", async () => {
    const h = harness();
    const svc: Services = { ...h.svc, visitId: () => undefined };
    await runCheckout(svc, h.view);
    expect(Object.keys(h.requests[0] ?? {})).not.toContain("visit_id");
  });

  it("a reused order (deduped) fires nothing and clears nothing (no vendor script runs), and still navigates", async () => {
    const h = harness({ checkout: { ok: true, response: { v: 1, event_id: EVENT_ID, snap_redirect_url: SNAP, value_idr: 49000, deduped: true } } });
    expect(await runCheckout(h.svc, h.view)).toBe(true);
    expect(h.events).toEqual(["token", "checkout", "spent", `navigate:${SNAP}`]);
  });

  it("a page with no pixel registered clears nothing and fires nothing", async () => {
    const h = harness({ pixelsEnabled: false });
    expect(await runCheckout(h.svc, h.view)).toBe(true);
    expect(h.events).toEqual(["token", "checkout", "spent", `navigate:${SNAP}`]);
  });
});

describe("not ready: nothing is sent", () => {
  const nothingSent = (h: ReturnType<typeof harness>): void => {
    expect(h.events.filter((e) => e === "token" || e === "checkout" || e.startsWith("navigate") || e.startsWith("fire"))).toEqual([]);
  };

  it("an incomplete form (no consent checkbox, or a missing field) says it cannot take orders", async () => {
    const h = harness({ incomplete: true });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.formErrors).toEqual([text.error.notReady]);
    expect(h.fieldErrors).toEqual([]);
    nothingSent(h);
  });

  it.each([
    ["the config could not be loaded", null],
    ["checkout is closed", { ...CONFIG, checkout_open: false }],
    ["the program has no published legal pages", { ...CONFIG, legal: null }],
  ])("%s", async (_name, config) => {
    const h = harness({ config });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.formErrors).toEqual([text.error.notReady]);
    nothingSent(h);
  });

  it("the consent links would not lead to the program's own legal pages (the play origin is not the API's sibling): checkout stays shut (security review S5)", async () => {
    for (const play_origin of ["https://play.evil.test", "https://play.example.test/legal", "http://play.example.test"]) {
      const h = harness({ config: { ...CONFIG, legal: { ...CONFIG.legal as NonNullable<SdkLpConfig["legal"]>, play_origin } } });
      expect(await runCheckout(h.svc, h.view), play_origin).toBe(false);
      expect(h.formErrors, play_origin).toEqual([text.error.notReady]);
      nothingSent(h);
    }
  });
});

describe("the visitor's values and the consent", () => {
  it("shows every invalid field and sends nothing, without even waiting for the config", async () => {
    const h = harness({ values: { name: "", phone: "12345", email: "bukan-email", consent: false } });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.fieldErrors).toEqual([{ name: "required", phone: "not_indonesian", email: "invalid", consent: "required" }]);
    expect(h.events).toEqual([]);
  });

  it("an unchecked consent box blocks the order", async () => {
    const h = harness({ values: { ...GOOD, consent: false } });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.fieldErrors).toEqual([{ consent: "required" }]);
    expect(h.events).toEqual([]);
  });

  it("sends the policy versions of the config, not anything the page supplied", async () => {
    const h = harness({ config: { ...CONFIG, legal: { ...(CONFIG.legal as NonNullable<SdkLpConfig["legal"]>), terms: 7, privacy: 4 } } });
    await runCheckout(h.svc, h.view);
    expect(h.requests[0]?.consent).toEqual({ terms: 7, privacy: 4 });
  });
});

describe("failures", () => {
  it("a Cap token that could not be solved shows the captcha message and sends nothing", async () => {
    const h = harness({ capToken: null });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.formErrors).toEqual([text.error.captcha]);
    expect(h.events).toEqual(["token"]);
  });

  it.each([
    ["captcha", text.error.captcha],
    ["sales_closed", text.error.salesClosed],
    ["rate_limited", text.error.rateLimited],
    ["gateway", text.error.gateway],
    ["unavailable", text.error.unavailable],
    ["network", text.error.network],
    ["origin", text.error.generic],
    ["validation", text.error.generic],
  ] as const)("the API's %s error shows its Bahasa Indonesia message, spends the Cap token and fires nothing", async (error, message) => {
    const h = harness({ checkout: { ok: false, error } });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.formErrors).toEqual([message]);
    expect(h.events).toEqual(["token", "checkout", "spent"]);
  });

  it("a validation error with field codes goes next to the fields", async () => {
    const fields: SdkFieldErrors = { phone: "not_mobile", consent: "outdated" };
    const h = harness({ checkout: { ok: false, error: "validation", fields } });
    expect(await runCheckout(h.svc, h.view)).toBe(false);
    expect(h.fieldErrors).toEqual([fields]);
    expect(h.formErrors).toEqual([]);
  });

  it.each(["https://evil.example.test/snap/v4/redirection/x", `${SNAP}?next=https://evil.example.test`, "http://app.sandbox.midtrans.com/snap/v4/redirection/x", "javascript:alert(1)"])(
    "a redirect URL that is not a Snap page (%s) is refused: no clearing, no pixel, no navigation",
    async (url) => {
      const h = harness({ checkout: { ok: true, response: { v: 1, event_id: EVENT_ID, snap_redirect_url: url, value_idr: 49000, deduped: false } } });
      expect(await runCheckout(h.svc, h.view)).toBe(false);
      expect(h.formErrors).toEqual([text.error.redirectRefused]);
      expect(h.events).toEqual(["token", "checkout", "spent"]);
    },
  );
});

describe("createSubmitGuard: one order at a time", () => {
  function guardWith(run: () => Promise<boolean>) {
    const log: string[] = [];
    const guard = createSubmitGuard(run, {
      start: () => log.push("start"),
      lock: (on) => log.push(on ? "lock" : "unlock"),
      crashed: () => log.push("crashed"),
    });
    return { guard, log };
  }

  it("ignores a second submit while one is in flight (double click, Enter twice, requestSubmit)", async () => {
    let finish: (leaving: boolean) => void = () => undefined;
    const run = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const { guard, log } = guardWith(run);
    guard.submit();
    guard.submit();
    guard.submit();
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["start", "lock"]);
    expect(guard.busy()).toBe(true);
    finish(false);
    await vi.waitFor(() => { expect(log).toEqual(["start", "lock", "unlock"]); });
    expect(guard.busy()).toBe(false);
    // Free again: the next submit runs.
    guard.submit();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stays locked when the page is leaving for the payment page, and unlocks on reset (back from the payment page)", async () => {
    const { guard, log } = guardWith(() => Promise.resolve(true));
    guard.submit();
    await Promise.resolve();
    await Promise.resolve();
    expect(guard.busy()).toBe(true);
    expect(log).toEqual(["start", "lock"]);
    guard.submit();
    expect(log).toEqual(["start", "lock"]);
    guard.reset();
    expect(log).toEqual(["start", "lock", "unlock"]);
    expect(guard.busy()).toBe(false);
    guard.reset();
    expect(log).toEqual(["start", "lock", "unlock"]);
  });

  it("an exception inside the flow shows the generic error and unlocks", async () => {
    const { guard, log } = guardWith(() => Promise.reject(new Error("boom")));
    guard.submit();
    await vi.waitFor(() => { expect(log).toEqual(["start", "lock", "crashed", "unlock"]); });
    expect(guard.busy()).toBe(false);
  });
});

describe("restoredFromCache: back from the payment page (security review L2)", () => {
  it("reloads the page when the vendor pixel libraries are live in it, so nothing is retyped under them, and leaves the lock alone", () => {
    const reload = vi.fn();
    const reset = vi.fn();
    restoredFromCache({ pixelsLoaded: () => true }, { reset }, reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("just unlocks the form when no vendor library was loaded (deduped order, no pixel registered)", () => {
    const reload = vi.fn();
    const reset = vi.fn();
    restoredFromCache({ pixelsLoaded: () => false }, { reset }, reload);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});
