"use client";

import { useEffect, useRef, useState } from "react";
import { CircleNotchIcon, CopyIcon } from "@phosphor-icons/react";
import { t } from "../../lib/t.ts";

/** Pending only: polling row. Under reduced motion the spinner stops and the text still says what is happening. */
export function PollingIndicator({ lastCheckedSeconds }: { lastCheckedSeconds: number }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
      <CircleNotchIcon aria-hidden="true" size={16} weight="bold" className="shrink-0 motion-safe:animate-spin" />
      <p className="flex flex-col sm:flex-row sm:gap-2">
        <span className="font-medium">{t("order.checking")}</span>
        <span className="text-muted-foreground tabular">{t("order.checkedAgo", { n: lastCheckedSeconds })}</span>
      </p>
    </div>
  );
}

/** 44px copy button for the order reference; shows a 3 s "Tersalin" toast. */
export function CopyRefButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  function copy() {
    void navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
    }, 3000);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-primary transition-colors duration-(--duration-base) hover:bg-muted"
      >
        <CopyIcon aria-hidden="true" size={20} />
        <span className="sr-only">{t("order.copyRef")}</span>
      </button>
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-(--z-toast) flex justify-center">
        {copied ? (
          <span className="reveal-in rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background shadow-lg">
            {t("order.copied")}
          </span>
        ) : null}
      </div>
    </>
  );
}
