"use client";

// The order status page's script (AC-S10, AC-T5; plan M6.6). Everything here runs in the browser of
// order.<DOMAIN>, in this order:
//   1. FIRST, before any vendor script exists in the page: the order's public id is kept in sessionStorage
//      and `history.replaceState` strips it (the path segment, and the Midtrans `order_id` query) from the
//      address, so the URL, and what a vendor library reads from it, no longer holds the capability. The
//      page's Referrer-Policy is strict-origin on top of that.
//   2. The status is polled (lib/order/poll.ts: backoff, a time limit, stops at a terminal state).
//   3. When the order is PAID and the landing page has pixels, ONE call to /claim asks the database for the
//      exactly-once claim; only the call that wins it gets the pixel ids and fires Purchase
//      (lib/order/pixels.ts). Another tab, a reload or a retry gets `fire: false`.
// The page renders fully without this script (the order code, the status, the WhatsApp link); the script
// only keeps it current. On the origin's root (no id in the URL: the page already stripped it and was
// reloaded) it sends the tab back to its order from sessionStorage.
import { PUBLIC_ID_PATTERN } from "@ebooktrivia/core/public-id";
import { useEffect, useRef, useState } from "react";
import { claimAndFire as claim } from "../../lib/order/claim.ts";
import { ORDER_API, type OrderClaimBody, PAGE_STATES, type PageState } from "../../lib/order/contract.ts";
import { type PollResult, pollOrder } from "../../lib/order/poll.ts";
import { firePurchase, type PixelWindow } from "../../lib/order/pixels.ts";
import { parsePixelIds } from "../../lib/order/vendors.ts";
import type { OrderView } from "../../lib/order/view.ts";
import { t } from "../../lib/t.ts";
import { ContextHelpBlock, useHelpShown } from "../help/cs-context.tsx";
import { OrderCard } from "./order-card.tsx";
import { PollingIndicator, PollingStopped } from "./order-client.tsx";

const STORAGE_KEY = "ebt:order:1";

function storedId(): string | null {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return value !== null && PUBLIC_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function keepId(id: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage blocked: the page keeps its id in memory for this load; a reload then has nothing to resume.
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterMs: number | undefined;
}

/** POST {v:1, id} to one of the page's own routes: no cookies, no referrer, never cached. Null on a network error. */
async function post(path: string, id: string, signal?: AbortSignal): Promise<Answer | null> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, id }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(signal === undefined ? {} : { signal }),
    });
    const retryAfter = Number(response.headers.get("retry-after"));
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined };
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function fetchStatus(id: string, signal: AbortSignal): Promise<PollResult> {
  const answer = await post(ORDER_API.status, id, signal);
  if (answer === null) return { kind: "retry" };
  if (answer.status === 404) return { kind: "gone" };
  const status = answer.status === 200 && isRecord(answer.body) ? answer.body["status"] : undefined;
  if (typeof status === "string" && (PAGE_STATES as readonly string[]).includes(status)) return { kind: "status", status: status as PageState };
  return { kind: "retry", ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }) };
}

/** The claim answer of a 200, or null (anything else, which the caller retries a few times). */
function claimOf(answer: Answer | null): OrderClaimBody | null {
  if (answer === null || answer.status !== 200 || !isRecord(answer.body) || answer.body["v"] !== 1) return null;
  const body = answer.body;
  if (body["fire"] === false) return { v: 1, fire: false };
  const eventId = body["event_id"];
  const transactionId = body["transaction_id"];
  const valueIdr = body["value_idr"];
  if (body["fire"] !== true || typeof eventId !== "string" || typeof transactionId !== "string" || typeof valueIdr !== "number") return null;
  // The ids are checked here too, against the vendors' formats, before they reach a script URL or a call.
  return { v: 1, fire: true, event_id: eventId, transaction_id: transactionId, value_idr: valueIdr, pixels: parsePixelIds(body["pixels"]) };
}

interface OrderLiveProps {
  /** The order's public id (from the URL); null on the origin's root. */
  readonly publicId: string | null;
  /** The server-rendered order; null on the origin's root. */
  readonly view: OrderView | null;
}

export function OrderLive({ publicId, view }: OrderLiveProps) {
  const [state, setState] = useState<PageState>(view?.state ?? "pending");
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  // The root of the origin only: true while a tab that has an order in sessionStorage is being sent back to it.
  const [resuming, setResuming] = useState(true);
  // False in the server render and until the script runs: the polling row only exists once something polls.
  const [mounted, setMounted] = useState(false);
  const stateRef = useRef<PageState>(state);
  const claimedRef = useRef(false);
  // The shared help block sits under the card; the states with a problem of their own point to it.
  const helpShown = useHelpShown();

  // 1. Strip the id from the address, before anything else in this page can run.
  useEffect(() => {
    setMounted(true);
    if (publicId === null) {
      const stored = storedId();
      if (stored === null) setResuming(false);
      else window.location.replace(`/${stored}`);
      return;
    }
    keepId(publicId);
    window.history.replaceState(null, "", "/");
  }, [publicId]);

  // 2. Poll, and 3. claim and fire once the order is paid.
  useEffect(() => {
    if (publicId === null || view === null) return;
    const controller = new AbortController();
    const { signal } = controller;

    // lib/order/claim.ts: one tick behind the abort signal, so React's development double mount (mount, unmount,
    // mount) sends one claim, not none and not two.
    const claimAndFire = async (): Promise<void> => {
      if (view.vendors.length === 0) return;
      await claim(claimedRef, {
        signal,
        sleep,
        request: async () => claimOf(await post(ORDER_API.claim, publicId, signal)),
        fire: (won) => firePurchase(window as PixelWindow, { eventId: won.event_id, transactionId: won.transaction_id, valueIdr: won.value_idr, pixels: won.pixels }),
      });
    };

    void (async () => {
      setCheckedAt(Date.now());
      if (stateRef.current === "paid") await claimAndFire();
      const outcome = await pollOrder(stateRef.current, {
        fetchStatus: () => fetchStatus(publicId, signal),
        sleep,
        now: () => Date.now(),
        signal,
        onStatus: (status) => {
          stateRef.current = status;
          setState(status);
          if (status === "paid") void claimAndFire();
        },
        onChecked: setCheckedAt,
      });
      if (outcome === "timeout" || outcome === "gone") setStopped(true);
    })();
    return () => {
      controller.abort();
    };
  }, [publicId, view, round]);

  // The "checked N seconds ago" line ticks while the order is pending.
  useEffect(() => {
    if (state !== "pending" || stopped) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [state, stopped]);

  if (view === null) {
    // A neutral loading state while the script looks for the tab's order (no "not found" flash), and the
    // plain "not found" for a tab without one. Without JavaScript nothing can resume an order, so a
    // <noscript> hides the loading state and shows the "not found".
    const notFound = (
      <>
        <h1 className="font-heading text-2xl leading-tight">{t("order.unknown.title")}</h1>
        <p className="text-base">{t("order.unknown.body")}</p>
      </>
    );
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10" data-testid="order-live" data-state={resuming ? "loading" : "unknown"}>
        <article className="flex w-full max-w-[480px] flex-col gap-3 rounded-2xl bg-card p-4 text-center text-card-foreground shadow-lg md:p-8">
          {resuming ? (
            <>
              <p role="status" className="text-base" data-resuming="">
                {t("common.loading")}
              </p>
              <noscript>
                <style>{"[data-resuming]{display:none}"}</style>
                {notFound}
              </noscript>
            </>
          ) : (
            notFound
          )}
        </article>
        <ContextHelpBlock className="max-w-[480px]" />
      </main>
    );
  }

  const seconds = checkedAt === null || now === null ? 0 : Math.max(0, Math.floor((now - checkedAt) / 1000));
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10" data-testid="order-live" data-state={state}>
      <OrderCard
        state={state}
        order={{ ref: view.code, product: view.product, amount: view.amountIdr, name: view.name, whatsapp: view.phone }}
        links={{ trivia: view.loginHref, again: view.orderAgainHref, whatsapp: view.whatsappHref }}
        pointToHelp={helpShown}
        polling={
          stopped ? (
            // The automatic checks ran out (an hour): every state that is still polled offers a manual check.
            <PollingStopped
              onRetry={() => {
                setStopped(false);
                setRound((n) => n + 1);
              }}
            />
          ) : state === "pending" ? (
            <>
              {mounted ? <PollingIndicator lastCheckedSeconds={seconds} /> : null}
              <noscript>
                <p className="rounded-lg bg-muted px-3 py-2 text-sm">{t("order.reloadToCheck")}</p>
              </noscript>
            </>
          ) : undefined
        }
      />
      <ContextHelpBlock orderCode={view.code} className="max-w-[480px]" />
    </main>
  );
}
