"use client";

// The OTP login of play.<DOMAIN>/login (US-026). Two steps on one card: the WhatsApp number (the Cap proof of
// work runs in the background from the first focus, as on the landing pages), then the 6-digit code.
// The copy after a request never says the number is known: the server answers every phone alike, and so
// does this page ("if this number is a buyer's, the code has been sent").
// a11y: every input has a visible label and a hint; errors sit next to their field (aria-invalid +
// aria-describedby) and are announced; focus moves to the code field, and to a field that has an error;
// the code field is autocomplete=one-time-code with a numeric keypad; 44 px targets; works at 375 px.
import { createCap, type CapSolver, type CapWindow } from "@ebooktrivia/sdk/cap";
import { normalizeIdMobile } from "@ebooktrivia/core/phone";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { t } from "../../lib/t.ts";
import { type ApiAnswer, postJson } from "./api.ts";
import { SignedInPanel } from "./signed-in-panel.tsx";

type Step = "phone" | "code";

/** The self-hosted widget files (scripts/sync-cap-assets.mjs) and the play Cap routes. */
const CAP_URLS = { script: "/cap/cap.js", wasm: "/cap/cap-wasm.wasm", hashwx: "/cap/cap-hashwx.wasm" } as const;
const CAP_API = "/api/v1/play/cap/";

function errorText(answer: ApiAnswer, wrongCode: boolean): string {
  if (answer.status === 0) return t("login.errors.network");
  if (answer.status === 429) return t("login.errors.rateLimited", { seconds: Math.max(answer.retryAfterSeconds, 1) });
  if (answer.body["error"] === "captcha") return t("login.errors.captcha");
  if (wrongCode && answer.body["error"] === "invalid_code") return t("login.errors.codeWrong");
  if (answer.body["error"] === "validation") return wrongCode ? t("login.errors.codeInvalid") : t("login.errors.phoneInvalid");
  return t("login.errors.unavailable");
}

function Spinner() {
  return <CircleNotchIcon aria-hidden="true" size={18} weight="bold" className="motion-safe:animate-spin" />;
}

export function LoginForm() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [e164, setE164] = useState("");
  const [code, setCode] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<{ readonly phoneMasked: string | null } | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cap = useRef<CapSolver | null>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  const solver = (): CapSolver => {
    cap.current ??= createCap(window as unknown as CapWindow, CAP_URLS, `${window.location.origin}${CAP_API}`, (input, init) => window.fetch(input, init));
    return cap.current;
  };

  useEffect(() => {
    if (resendAt <= now) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [resendAt, now]);

  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  /** Asks for a code; the answer is the same for every number. */
  async function requestCode(target: string, onError: (message: string) => void): Promise<void> {
    const token = await solver().token();
    if (token === null) {
      onError(t("login.errors.captcha"));
      return;
    }
    const answer = await postJson("/api/v1/play/auth/otp", { phone: target, cap_token: token });
    solver().spent();
    solver().warm();
    if (answer.status === 200) {
      const wait = Number(answer.body["resend_after_seconds"]);
      setResendAt(Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60) * 1000);
      setNow(Date.now());
      setStep("code");
      return;
    }
    if (answer.status === 429) {
      setResendAt(Date.now() + Math.max(answer.retryAfterSeconds, 1) * 1000);
      setNow(Date.now());
    }
    onError(errorText(answer, false));
  }

  async function submitPhone(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const parsed = normalizeIdMobile(phone);
    if (!parsed.ok) {
      setPhoneError(t("login.errors.phoneInvalid"));
      phoneInput.current?.focus();
      return;
    }
    setPhoneError(null);
    setBusy(true);
    setE164(parsed.e164);
    await requestCode(parsed.e164, (message) => {
      setPhoneError(message);
      phoneInput.current?.focus();
    });
    setBusy(false);
  }

  async function submitCode(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!/^[0-9]{6}$/.test(code)) {
      setCodeError(t("login.errors.codeInvalid"));
      codeInput.current?.focus();
      return;
    }
    setCodeError(null);
    setBusy(true);
    // Every check of a code carries its own proof of work (a Cap token is single use): the one solved in the
    // background since the last request, or a fresh one now; the next one starts solving right after.
    const token = await solver().token();
    if (token === null) {
      setBusy(false);
      setCodeError(t("login.errors.captcha"));
      codeInput.current?.focus();
      return;
    }
    const answer = await postJson("/api/v1/play/auth/otp/verify", { phone: e164, code, cap_token: token });
    solver().spent();
    solver().warm();
    if (answer.status === 200) {
      const masked = answer.body["phone_masked"];
      setSignedIn({ phoneMasked: typeof masked === "string" ? masked : null });
      return;
    }
    setBusy(false);
    setCodeError(errorText(answer, true));
    codeInput.current?.focus();
  }

  /**
   * "Kirim tautan masuk" (US-027, Owner decision): a new login link by WhatsApp and e-mail, the way in when the
   * code checks are used up. The answer, and so this copy, is the same for every number.
   */
  async function requestLink(target: string, onError: (message: string) => void): Promise<void> {
    setLinkNotice(null);
    const token = await solver().token();
    if (token === null) {
      onError(t("login.errors.captcha"));
      return;
    }
    const answer = await postJson("/api/v1/play/auth/magic-link/resend", { phone: target, cap_token: token });
    solver().spent();
    solver().warm();
    if (answer.status === 200) {
      setLinkNotice(t("login.linkSent", { phone: target }));
      return;
    }
    onError(errorText(answer, false));
  }

  async function sendLink(): Promise<void> {
    if (busy) return;
    const target = step === "code" ? { ok: true as const, e164 } : normalizeIdMobile(phone);
    if (!target.ok) {
      setPhoneError(t("login.errors.phoneInvalid"));
      phoneInput.current?.focus();
      return;
    }
    setBusy(true);
    if (step === "code") setCodeError(null);
    else setPhoneError(null);
    await requestLink(target.e164, (message) => {
      if (step === "code") {
        setCodeError(message);
      } else {
        setPhoneError(message);
        phoneInput.current?.focus();
      }
    });
    setBusy(false);
  }

  async function resend(): Promise<void> {
    if (busy || resendAt > Date.now()) return;
    setBusy(true);
    setCodeError(null);
    setCode("");
    await requestCode(e164, (message) => {
      setCodeError(message);
    });
    setBusy(false);
  }

  const waitSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));

  if (signedIn !== null) return <SignedInPanel phoneMasked={signedIn.phoneMasked} />;

  return (
    <section aria-labelledby="login-title" className="flex w-full max-w-[420px] flex-col gap-5 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
      <header className="flex flex-col gap-2">
        <h1 id="login-title" className="font-heading text-2xl leading-tight">
          {step === "phone" ? t("login.title") : t("login.codeTitle")}
        </h1>
        <p className="text-base" aria-live="polite">
          {step === "phone" ? t("login.intro") : t("login.codeSent", { phone: e164 })}
        </p>
      </header>

      {step === "phone" ? (
        <form noValidate onSubmit={(event) => void submitPhone(event)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-phone">{t("login.phoneLabel")}</Label>
            <Input
              ref={phoneInput}
              id="login-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={32}
              value={phone}
              aria-invalid={phoneError !== null}
              aria-describedby={phoneError === null ? "login-phone-hint" : "login-phone-hint login-phone-error"}
              onFocus={() => {
                solver().warm();
              }}
              onChange={(event) => {
                setPhone(event.target.value);
                if (phoneError !== null) setPhoneError(null);
              }}
            />
            <p id="login-phone-hint" className="text-sm text-muted-foreground">
              {t("login.phoneHint")}
            </p>
            {phoneError === null ? null : (
              <p id="login-phone-error" role="alert" className="text-sm font-medium text-destructive">
                {phoneError}
              </p>
            )}
          </div>
          <Button type="submit" size="lg" disabled={busy} aria-disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? t("login.sending") : t("login.sendCode")}
          </Button>
          <p className="text-sm text-muted-foreground">{t("login.magicLinkHint")}</p>
        </form>
      ) : null}
      {step === "code" ? (
        <form noValidate onSubmit={(event) => void submitCode(event)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-code">{t("login.codeLabel")}</Label>
            <Input
              ref={codeInput}
              id="login-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              className="text-center font-heading text-2xl tracking-[0.4em] tabular"
              value={code}
              aria-invalid={codeError !== null}
              aria-describedby={codeError === null ? "login-code-hint" : "login-code-hint login-code-error"}
              onChange={(event) => {
                setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6));
                if (codeError !== null) setCodeError(null);
              }}
            />
            <p id="login-code-hint" className="text-sm text-muted-foreground">
              {t("login.codeHint")}
            </p>
            {codeError === null ? null : (
              <p id="login-code-error" role="alert" className="text-sm font-medium text-destructive">
                {codeError}
              </p>
            )}
          </div>
          <Button type="submit" size="lg" disabled={busy} aria-disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? t("login.verifying") : t("login.verify")}
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" disabled={busy || waitSeconds > 0} aria-disabled={busy || waitSeconds > 0} onClick={() => void resend()}>
              {waitSeconds > 0 ? t("login.resendIn", { seconds: waitSeconds }) : t("login.resend")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setStep("phone");
                setCode("");
                setCodeError(null);
                window.setTimeout(() => phoneInput.current?.focus(), 0);
              }}
            >
              {t("login.changeNumber")}
            </Button>
          </div>
        </form>
      ) : null}
      <div className="flex flex-col gap-2 border-t pt-4">
        <p className="text-sm text-muted-foreground">{t("login.linkHint")}</p>
        <Button type="button" variant="outline" disabled={busy} aria-disabled={busy} onClick={() => void sendLink()}>
          {t("login.sendLink")}
        </Button>
        {linkNotice === null ? null : (
          <p role="status" className="rounded-lg bg-info-soft px-3 py-2 text-base text-info-soft-foreground">
            {linkNotice}
          </p>
        )}
      </div>
    </section>
  );
}
