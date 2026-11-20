// Binding to the landing page's own HTML form (the DOM side; the checkout flow itself is flow.ts).
// The LP author writes the form; the SDK finds it through data attributes (documented in
// packages/sdk/README.md):
//
//   <form data-ebt-checkout method="post">
//     <input data-ebt-field="name"> <input data-ebt-field="phone"> <input data-ebt-field="email">
//     <input type="checkbox" data-ebt-consent> <span data-ebt-consent-label></span>
//     <button type="submit" disabled>...</button>
//   </form>
//
// The submit button ships `disabled` and the form `method="post"`: until the SDK has bound, a click
// or Enter cannot submit natively, and if the script never loads a submit would at worst POST (a GET
// would put the buyer's name, phone and e-mail in the URL). Binding enables the button.
//
// Optional: [data-ebt-error="name|phone|email|consent"] (where that field's error goes) and
// [data-ebt-status] (the live region for progress). Everything the SDK injects is built with
// createElement and textContent (never innerHTML, never a string from the network), styled by
// low-specificity rules the page's own CSS overrides, and announced to assistive technology:
// field errors are linked with aria-describedby / aria-invalid and the first invalid field gets
// focus; progress is a polite live region; form-level errors are role="alert".
import type { SdkField, SdkFieldErrors } from "@ebooktrivia/core/sdk-contract";
import { createSubmitGuard, type FlowView, restoredFromCache, runCheckout, type Services } from "./flow.ts";
import { legalLinks } from "./legal.ts";
import { text } from "./messages.ts";
import { fieldMessage, type FormValues } from "./validate.ts";

export type { Services } from "./flow.ts";

const FIELDS: readonly SdkField[] = ["name", "phone", "email", "consent"];

const STYLE = [
  ":where(.ebt-error,.ebt-form-error){color:#b91c1c;font-size:.875em;line-height:1.4;margin:.25em 0 0}",
  ":where(.ebt-status){font-size:.875em;line-height:1.4;margin:.5em 0 0}",
  ':where([data-ebt-field][aria-invalid="true"],[data-ebt-consent][aria-invalid="true"]){outline:2px solid #b91c1c;outline-offset:1px}',
  ":where([data-ebt-consent-label] a){text-decoration:underline}",
].join("");

/** Constructable stylesheets are not subject to a page's style-src, unlike <style> elements. */
export function installStyles(doc: Document): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    // An older browser: the injected messages are unstyled but still shown.
  }
}

function legalLink(doc: Document, href: string, label: string): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  a.setAttribute("aria-label", `${label} (${text.consent.newTab})`);
  return a;
}

export function bindForm(form: HTMLFormElement, index: number, svc: Services): void {
  const doc = form.ownerDocument;
  const win = doc.defaultView ?? window;
  const prefix = `ebt${String(index)}`;
  form.noValidate = true;

  const input = (name: string): HTMLInputElement | null => form.querySelector<HTMLInputElement>(`[data-ebt-field="${name}"]`);
  const consentBox = (): HTMLInputElement | null => form.querySelector<HTMLInputElement>("[data-ebt-consent]");
  const controls = (): HTMLElement[] => [...form.querySelectorAll<HTMLElement>("button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]")];
  const target = (field: SdkField): HTMLElement | null => (field === "consent" ? consentBox() : input(field));

  // --- Messages ---------------------------------------------------------------------------------

  const errorEls = new Map<SdkField, HTMLElement>();
  let statusEl: HTMLElement | null = null;
  let alertEl: HTMLElement | null = null;

  const describedBy = (el: HTMLElement, id: string, on: boolean): void => {
    const tokens = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((t) => t !== "" && t !== id);
    if (on) tokens.push(id);
    if (tokens.length > 0) el.setAttribute("aria-describedby", tokens.join(" "));
    else el.removeAttribute("aria-describedby");
  };

  function showFieldError(field: SdkField, message: string): void {
    const el = target(field);
    if (el === null) return;
    let box = errorEls.get(field);
    if (box === undefined) {
      const slot = form.querySelector<HTMLElement>(`[data-ebt-error="${field}"]`);
      box = slot ?? doc.createElement("p");
      if (slot === null) {
        box.className = "ebt-error";
        // After the field's <label> when it sits inside one: a <p> inside a label would become part of its name.
        const anchor = el.closest("label") ?? (field === "consent" ? form.querySelector("[data-ebt-consent-label]") : null) ?? el;
        anchor.insertAdjacentElement("afterend", box);
      }
      box.id = box.id === "" ? `${prefix}-${field}-error` : box.id;
      errorEls.set(field, box);
    }
    box.textContent = message;
    describedBy(el, box.id, true);
    el.setAttribute("aria-invalid", "true");
  }

  function clearFieldErrors(): void {
    for (const field of FIELDS) {
      const el = target(field);
      const box = errorEls.get(field);
      if (box !== undefined) {
        box.textContent = "";
        if (el !== null) describedBy(el, box.id, false);
      }
      el?.removeAttribute("aria-invalid");
    }
  }

  const status = (message: string): void => {
    if (statusEl === null) {
      statusEl = form.querySelector<HTMLElement>("[data-ebt-status]");
      if (statusEl === null) {
        statusEl = doc.createElement("p");
        statusEl.className = "ebt-status";
        form.append(statusEl);
      }
      statusEl.setAttribute("role", "status");
      statusEl.setAttribute("aria-live", "polite");
    }
    statusEl.textContent = message;
  };

  const formError = (message: string): void => {
    if (alertEl === null) {
      alertEl = doc.createElement("p");
      alertEl.className = "ebt-form-error";
      alertEl.setAttribute("role", "alert");
      form.append(alertEl);
    }
    alertEl.textContent = message;
  };

  function showFieldErrors(errors: SdkFieldErrors): void {
    let first: HTMLElement | null = null;
    for (const field of FIELDS) {
      const code = errors[field];
      if (code === undefined) continue;
      showFieldError(field, fieldMessage(field, code));
      first ??= target(field);
    }
    first?.focus();
  }

  // --- Consent (AC-A10): links to the program's legal pages ------------------------------------

  void svc.config.then((config) => {
    const box = consentBox();
    const links = config === null ? null : legalLinks(svc.apiOrigin, config.legal);
    if (box === null || links === null) return;
    let holder = form.querySelector<HTMLElement>("[data-ebt-consent-label]");
    if (holder === null) {
      holder = doc.createElement("span");
      holder.setAttribute("data-ebt-consent-label", "");
      (box.closest("label") ?? box).insertAdjacentElement("afterend", holder);
      if (box.labels?.length === 0) {
        holder.id = `${prefix}-consent-label`;
        box.setAttribute("aria-labelledby", holder.id);
      }
    }
    const c = text.consent;
    holder.replaceChildren(`${c.lead} `, legalLink(doc, links.terms, c.terms), ` ${c.and} `, legalLink(doc, links.privacy, c.privacy), ".");
  });

  // --- Submit -----------------------------------------------------------------------------------

  let buttonHadFocus = false;
  const lock = (on: boolean): void => {
    // A disabled button loses focus: remember it and give it back, unless a field took it for an error.
    if (on) buttonHadFocus = controls().includes(doc.activeElement as HTMLElement);
    for (const el of controls()) {
      if (on) el.setAttribute("disabled", "");
      else el.removeAttribute("disabled");
    }
    if (on) form.setAttribute("aria-busy", "true");
    else form.removeAttribute("aria-busy");
    status(on ? text.submitting : "");
    if (!on && buttonHadFocus && (doc.activeElement === null || doc.activeElement === doc.body)) controls()[0]?.focus();
  };

  const read = (): FormValues => ({
    name: input("name")?.value ?? "",
    phone: input("phone")?.value ?? "",
    email: input("email")?.value ?? "",
    consent: consentBox()?.checked ?? false,
  });

  const view: FlowView = {
    incomplete: () => input("name") === null || input("phone") === null || input("email") === null || consentBox() === null,
    read,
    fieldErrors: showFieldErrors,
    formError,
    // Only THIS form is emptied: the page must have no personal-data input outside it (README, "What the page must not do").
    clearPersonalData() {
      for (const el of form.querySelectorAll<HTMLInputElement>('[data-ebt-field], input[type="email"], input[type="tel"]')) el.value = "";
    },
  };

  const guard = createSubmitGuard(() => runCheckout(svc, view), {
    start() {
      clearFieldErrors();
      if (alertEl !== null) alertEl.textContent = "";
    },
    lock,
    crashed() {
      formError(text.error.generic);
    },
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    guard.submit();
  });
  // First interaction: start loading Cap and solving, so the token is ready by the time they submit.
  form.addEventListener(
    "focusin",
    () => {
      svc.cap.warm();
    },
    { once: true },
  );
  // Back from the payment page (bfcache): the form is usable again, or, when the vendor pixel
  // libraries are live in this page, the page is reloaded so nothing is retyped under them.
  win.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      restoredFromCache(svc, guard, () => {
        win.location.reload();
      });
    }
  });
  // The SDK is here and listening: the submit button the page shipped disabled can take clicks now.
  for (const el of controls()) el.removeAttribute("disabled");
}
