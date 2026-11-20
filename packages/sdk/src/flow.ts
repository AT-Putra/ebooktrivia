// The checkout flow, free of the DOM so it can be tested without one (form.ts is the DOM side).
// A submit goes: the form is complete -> the visitor's values are valid -> the page's config says
// checkout is open and its consent links are sound -> a Cap token -> the API -> the redirect URL
// is a Snap page -> (the page's own values are cleared, the MO pixel fires) -> navigate.
import type { SdkAttribution, SdkFieldErrors, SdkLpConfig } from "@ebooktrivia/core/sdk-contract";
import type { Api } from "./api.ts";
import type { CapSolver } from "./cap.ts";
import { legalLinks } from "./legal.ts";
import { text } from "./messages.ts";
import type { Pixels } from "./pixels.ts";
import { snapRedirectTarget } from "./redirect.ts";
import { checkForm, type FormValues } from "./validate.ts";

export interface Services {
  /** Resolves with the page's config, or null when it could not be loaded. */
  readonly config: Promise<SdkLpConfig | null>;
  /** The origin the SDK was loaded from (the API). */
  readonly apiOrigin: string;
  readonly attribution: () => SdkAttribution;
  readonly visitId: () => string | undefined;
  readonly api: Api;
  readonly cap: CapSolver;
  readonly pixelsFor: (config: SdkLpConfig) => Pixels;
  /** True when the vendor pixel libraries are live in this page. */
  readonly pixelsLoaded: () => boolean;
  readonly navigate: (url: string) => void;
}

/** What the flow needs from the form it runs on. */
export interface FlowView {
  /** True when the form lacks a name, phone or e-mail field or the consent checkbox. */
  readonly incomplete: () => boolean;
  readonly read: () => FormValues;
  readonly fieldErrors: (errors: SdkFieldErrors) => void;
  readonly formError: (message: string) => void;
  /** Empties the visitor's name, phone and e-mail inputs. */
  readonly clearPersonalData: () => void;
}

const FAILURES: Readonly<Record<string, string>> = {
  captcha: text.error.captcha,
  sales_closed: text.error.salesClosed,
  rate_limited: text.error.rateLimited,
  gateway: text.error.gateway,
  unavailable: text.error.unavailable,
  network: text.error.network,
};

/** True when the page is on its way to the payment page; false when the form should be usable again. */
export async function runCheckout(svc: Services, view: FlowView): Promise<boolean> {
  // A form the page author left incomplete cannot take an order: say so instead of failing silently.
  if (view.incomplete()) {
    view.formError(text.error.notReady);
    return false;
  }
  const checked = checkForm(view.read());
  if (!checked.ok) {
    view.fieldErrors(checked.errors);
    return false;
  }
  const config = await svc.config;
  // Without the config, an open checkout and consent links that lead to the program's own legal
  // pages, no order is taken: the buyer must be able to read what they consent to.
  if (config === null || !config.checkout_open || config.legal === null || legalLinks(svc.apiOrigin, config.legal) === null) {
    view.formError(text.error.notReady);
    return false;
  }
  const pixels = svc.pixelsFor(config);
  const capToken = await svc.cap.token();
  if (capToken === null) {
    view.formError(text.error.captcha);
    return false;
  }
  const visitId = svc.visitId();
  const result = await svc.api.checkout({
    name: checked.name,
    phone: checked.phone,
    email: checked.email,
    cap_token: capToken,
    consent: { terms: config.legal.terms, privacy: config.legal.privacy },
    attribution: svc.attribution(),
    ...(visitId === undefined ? {} : { visit_id: visitId }),
  });
  // The server has seen the token, and a token works once: the next attempt solves a fresh one.
  svc.cap.spent();
  if (!result.ok) {
    if (result.error === "validation" && result.fields !== undefined) view.fieldErrors(result.fields);
    else view.formError(FAILURES[result.error] ?? text.error.generic);
    return false;
  }
  const url = snapRedirectTarget(result.response.snap_redirect_url, config.midtrans_env);
  if (url === null) {
    view.formError(text.error.redirectRefused);
    return false;
  }
  // The MO pixel, once per order and only with the server's event id; a reused order (deduped)
  // already fired it. The vendor scripts only load now, after the visitor's values are gone from the
  // page: their automatic advanced matching reads e-mail and phone fields from the DOM.
  if (!result.response.deduped && pixels.enabled) {
    view.clearPersonalData();
    await pixels.fireInitiateCheckout(result.response.event_id, result.response.value_idr);
  }
  svc.navigate(url);
  return true;
}

/**
 * The page came back from the back-forward cache (the buyer pressed Back from the payment page). The
 * form has been emptied, and if the vendor pixel libraries were loaded they are still running in this
 * very page: a buyer who retypes their name, phone and e-mail here would do it with them live. So the
 * page is reloaded from scratch; otherwise the form is simply usable again.
 */
export function restoredFromCache(svc: Pick<Services, "pixelsLoaded">, guard: Pick<SubmitGuard, "reset">, reload: () => void): void {
  if (svc.pixelsLoaded()) reload();
  else guard.reset();
}

export interface SubmitGuard {
  /** One submit event. Ignored while another is in flight. */
  submit(): void;
  /** Unlocks (back from the payment page). */
  reset(): void;
  busy(): boolean;
}

/**
 * Makes a form take one order at a time: a second submit event (double click, Enter twice,
 * `requestSubmit()`) while one is in flight does nothing. On success the page is leaving, so the
 * form stays locked; on failure, or an exception, it unlocks.
 */
export function createSubmitGuard(run: () => Promise<boolean>, hooks: { readonly start: () => void; readonly lock: (on: boolean) => void; readonly crashed: () => void }): SubmitGuard {
  let busy = false;
  return {
    submit() {
      if (busy) return;
      busy = true;
      hooks.start();
      hooks.lock(true);
      run().then(
        (leaving) => {
          if (!leaving) {
            busy = false;
            hooks.lock(false);
          }
        },
        () => {
          hooks.crashed();
          busy = false;
          hooks.lock(false);
        },
      );
    },
    reset() {
      if (!busy) return;
      busy = false;
      hooks.lock(false);
    },
    busy: () => busy,
  };
}
