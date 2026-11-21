"use client";

// The question screen of one set (US-027, AC-Q6 to AC-Q9; plan M9.3). The SERVER is the clock: this page only
// shows the time the server returned (remaining_ms, resynced on every call) and never decides anything with its
// own clock. A refresh or a second tab asks the server again (POST current) and gets the same question with less
// time; closing the page does not stop the timer. The question's options arrive as opaque ids with labels, in this
// attempt's order; which one is correct, and the explanation, arrive only in the answer's response.
//
// Flow: intro (not started) -> POST start -> POST current -> question -> POST answer -> result -> "Lanjut" ->
// POST current ...
// Fairness at the end of the time (security review MEDIUM-1): when the shown time reaches 0 the options stay
// ENABLED for the server's latency grace (1500 ms), the same grace a script gets: the page shows 0 and the server
// decides (a pick it refuses answers too_late). Only once the grace has passed (or the server said too_late) does
// the page show the time-up screen, with the same "Lanjut" as after an answer: it never asks for the next question
// by itself (lead decision, code review MAJOR-2), so a tab left alone loses at most the one question it shows.
// Accessibility: the timer is a `timer` without live announcements; a polite status region speaks only at 10 s,
// 5 s and at the end; focus moves to each new question and to each result; animations respect reduced motion.
import { Button } from "@ebooktrivia/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@ebooktrivia/ui/components/dialog";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { CheckCircleIcon, HourglassIcon, LockSimpleIcon, TrophyIcon, WarningIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatMs, formatNumber } from "../../../lib/format.ts";
import { LATENCY_GRACE_MS } from "../../../lib/play/timing.ts";
import { t } from "../../../lib/t.ts";
import { type ApiAnswer, postJson } from "../../play/api.ts";

const LETTERS = ["A", "B", "C", "D"] as const;
const RING_RADIUS = 28;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const LOW_SECONDS = 5;
/** The time-up screen comes this long after the server's latency grace has passed (its clock may be a little behind). */
const SETTLE_MARGIN_MS = 250;

interface Option {
  readonly id: string;
  readonly label: string;
}

interface Question {
  readonly answerId: string;
  readonly position: number;
  readonly total: number;
  readonly prompt: string;
  readonly options: readonly Option[];
  readonly remainingMs: number;
  readonly windowMs: number;
  /** performance.now() when the server's answer arrived: the base of the shown countdown. */
  readonly receivedAt: number;
  readonly previousTimedOut: boolean;
}

interface Result {
  readonly correct: boolean;
  readonly points: number;
  readonly correctOptionId: string | null;
  readonly explanation: string | null;
}

type Screen =
  | { readonly kind: "intro" }
  | { readonly kind: "loading" }
  | { readonly kind: "question"; readonly q: Question }
  /** stoppedSeconds: what the countdown showed when the player picked (it stays there). */
  | { readonly kind: "answering"; readonly q: Question; readonly chosen: string; readonly stoppedSeconds: number }
  | { readonly kind: "answered"; readonly q: Question; readonly chosen: string; readonly stoppedSeconds: number; readonly result: Result }
  | { readonly kind: "timeup"; readonly q: Question; readonly tooLate: boolean }
  | { readonly kind: "finished"; readonly score: number; readonly totalMs: number }
  | { readonly kind: "closed" }
  | { readonly kind: "locked" }
  | { readonly kind: "error" };

export interface PlaySetProps {
  readonly programId: string;
  readonly programSlug: string;
  readonly setId: string;
  readonly setNumber: number;
  readonly setTitle: string;
  readonly questionCount: number;
  /** The player's attempt on the set, if started: the page resumes it at once. */
  readonly attemptId: string | null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function parseQuestion(body: Readonly<Record<string, unknown>>): Question {
  const options = Array.isArray(body["options"]) ? (body["options"] as Record<string, unknown>[]) : [];
  return {
    answerId: str(body["answer_id"]),
    position: num(body["position"]),
    total: num(body["total"]),
    prompt: str(body["prompt"]),
    options: options.map((o) => ({ id: str(o["id"]), label: str(o["label"]) })),
    remainingMs: num(body["remaining_ms"]),
    windowMs: Math.max(1, num(body["window_ms"])),
    receivedAt: performance.now(),
    previousTimedOut: num(body["timed_out"]) > 0,
  };
}

const leftMs = (q: Question, at: number): number => Math.max(0, q.remainingMs - (at - q.receivedAt));

function Ring({ remaining, windowSeconds, low }: { readonly remaining: number; readonly windowSeconds: number; readonly low: boolean }) {
  const offset = RING_LENGTH * (1 - Math.min(1, remaining / windowSeconds));
  return (
    <div role="timer" aria-live="off" aria-label={t("play.timerLabel", { n: remaining })} className="relative size-16 shrink-0">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={RING_RADIUS} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          cx="32"
          cy="32"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={offset}
          className={cn("motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear", low ? "stroke-warning" : "stroke-primary")}
        />
      </svg>
      <span aria-hidden="true" className={cn("timer-digits absolute inset-0 flex items-center justify-center text-xl", low ? "font-bold text-warning" : "font-semibold")}>
        <span className="inline-block w-[3ch] text-center">{remaining}</span>
      </span>
    </div>
  );
}

type OptionTone = "idle" | "chosen" | "correct" | "wrong" | "reveal" | "dim";

const TONE_CLASS: Record<OptionTone, string> = {
  idle: "border-input bg-card text-card-foreground hover:bg-muted",
  chosen: "border-primary bg-muted text-foreground",
  correct: "border-success bg-success text-on-success",
  wrong: "border-destructive bg-destructive-soft text-destructive-soft-foreground",
  reveal: "border-success bg-success-soft text-success-soft-foreground",
  dim: "border-border bg-muted text-muted-foreground",
};

export function PlaySet(props: PlaySetProps) {
  const [screen, setScreen] = useState<Screen>(props.attemptId === null ? { kind: "intro" } : { kind: "loading" });
  const [attemptId, setAttemptId] = useState(props.attemptId);
  const [clock, setClock] = useState(() => performance.now());
  const [rank, setRank] = useState<number | null>(null);
  const focusTarget = useRef<HTMLElement | null>(null);
  const backHref = `/${props.programSlug}`;

  /** Handles the answers every play call can give besides its own success. */
  const failed = useCallback((answer: ApiAnswer): Screen => {
    if (answer.status === 401) {
      window.location.assign("/login");
      return { kind: "loading" };
    }
    const error = str(answer.body["error"]);
    if (error === "closed") return { kind: "closed" };
    if (error === "locked") return { kind: "locked" };
    return { kind: "error" };
  }, []);

  const loadCurrent = useCallback(
    async (attempt: string): Promise<void> => {
      const answer = await postJson("/api/v1/play/attempts/current", { attempt_id: attempt });
      if (answer.status !== 200) {
        setScreen(failed(answer));
        return;
      }
      const state = str(answer.body["state"]);
      if (state === "question") setScreen({ kind: "question", q: parseQuestion(answer.body) });
      else if (state === "finished") setScreen({ kind: "finished", score: num(answer.body["score"]), totalMs: num(answer.body["total_ms"]) });
      else if (state === "closed") setScreen({ kind: "closed" });
      else setScreen({ kind: "error" });
    },
    [failed],
  );

  // Resume a started attempt at once.
  useEffect(() => {
    if (props.attemptId !== null) void loadCurrent(props.attemptId);
  }, [props.attemptId, loadCurrent]);

  // The shown countdown (4 times a second), and the end of the shown time.
  const q = screen.kind === "question" ? screen.q : null;
  useEffect(() => {
    if (q === null) return;
    const id = setInterval(() => {
      setClock(performance.now());
    }, 250);
    return () => {
      clearInterval(id);
    };
  }, [q]);
  // At 0 the options stay enabled through the latency grace; after it, the time-up screen (no request is made: the
  // player moves on with "Lanjut").
  useEffect(() => {
    if (q === null) return;
    if (clock - q.receivedAt < q.remainingMs + LATENCY_GRACE_MS + SETTLE_MARGIN_MS) return;
    setScreen({ kind: "timeup", q, tooLate: false });
  }, [q, clock]);

  // Focus: each new question's heading, each result, the end screens.
  const focusKey = screen.kind === "question" ? `q:${screen.q.answerId}` : screen.kind === "answered" || screen.kind === "timeup" ? `r:${screen.q.answerId}` : screen.kind;
  useEffect(() => {
    focusTarget.current?.focus();
  }, [focusKey]);

  // The rank on the result screen: the player's own standing, fresh.
  useEffect(() => {
    if (screen.kind !== "finished") return;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/play/leaderboard?program=${encodeURIComponent(props.programId)}`, { credentials: "same-origin", cache: "no-store", redirect: "error" });
        const body = (await response.json().catch(() => ({}))) as { me?: { rank?: unknown } };
        setRank(typeof body.me?.rank === "number" ? body.me.rank : null);
      } catch {
        setRank(null);
      }
    })();
  }, [screen.kind, props.programId]);

  async function start(): Promise<void> {
    setScreen({ kind: "loading" });
    const answer = await postJson("/api/v1/play/sets/start", { set_id: props.setId });
    const id = str(answer.body["attempt_id"]);
    if (answer.status !== 200 || id === "") {
      setScreen(failed(answer));
      return;
    }
    setAttemptId(id);
    await loadCurrent(id);
  }

  async function choose(question: Question, optionId: string): Promise<void> {
    if (attemptId === null) return;
    const stoppedSeconds = Math.ceil(leftMs(question, performance.now()) / 1000);
    setScreen({ kind: "answering", q: question, chosen: optionId, stoppedSeconds });
    const answer = await postJson("/api/v1/play/attempts/answer", { answer_id: question.answerId, option_id: optionId });
    if (answer.status === 200) {
      setScreen({
        kind: "answered",
        q: question,
        // The pick the server recorded (another tab's, when this one came second).
        chosen: str(answer.body["option_id"]) === "" ? optionId : str(answer.body["option_id"]),
        stoppedSeconds,
        result: {
          correct: answer.body["correct"] === true,
          points: num(answer.body["points"]),
          correctOptionId: typeof answer.body["correct_option_id"] === "string" ? answer.body["correct_option_id"] : null,
          explanation: typeof answer.body["explanation"] === "string" && answer.body["explanation"] !== "" ? answer.body["explanation"] : null,
        },
      });
      return;
    }
    const error = str(answer.body["error"]);
    if (error === "too_late") {
      setScreen({ kind: "timeup", q: question, tooLate: true });
      return;
    }
    if (error === "already_answered" || error === "not_served") {
      await loadCurrent(attemptId);
      return;
    }
    setScreen(failed(answer));
  }

  const setFocus = (el: HTMLElement | null) => {
    focusTarget.current = el;
  };

  const header = (position: number | null, total: number | null) => (
    <header className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-heading text-2xl">{t("play.title", { n: props.setNumber })}</p>
        {position === null || total === null ? (
          <p className="text-sm break-words text-muted-foreground">{props.setTitle}</p>
        ) : (
          <div className="flex items-center gap-2">
            <progress
              value={position}
              max={total}
              aria-label={t("play.progress", { current: position, total })}
              className="h-2 w-full max-w-40 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
            />
            <p className="text-sm font-medium text-muted-foreground tabular">{t("play.progress", { current: position, total })}</p>
          </div>
        )}
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline" size="icon">
            <XIcon aria-hidden="true" size={20} weight="bold" />
            <span className="sr-only">{t("play.exit")}</span>
          </Button>
        </DialogTrigger>
        <DialogContent closeLabel={t("trivia.close")}>
          <DialogHeader>
            <DialogTitle>{t("play.exit")}</DialogTitle>
            <DialogDescription>{t("play.exitWarning")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">{t("trivia.close")}</Button>
            </DialogClose>
            <Button asChild>
              <a href={backHref}>{t("play.exit")}</a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );

  const notice = (title: string, body: string, icon: ReactNode) => (
    <div className="flex flex-col gap-4">
      {header(null, null)}
      <div className="reveal-in flex flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center shadow-md">
        {icon}
        <h1 ref={setFocus} tabIndex={-1} className="font-heading text-2xl outline-none">
          {title}
        </h1>
        <p className="max-w-[65ch] text-base">{body}</p>
        <Button asChild variant="cta" size="lg" className="w-full">
          <a href={backHref}>{t("play.backToSets")}</a>
        </Button>
      </div>
    </div>
  );

  switch (screen.kind) {
    case "intro":
      return (
        <div className="flex flex-col gap-4">
          <div className="reveal-in flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-md md:p-6">
            <h1 ref={setFocus} tabIndex={-1} className="font-heading text-2xl break-words outline-none">
              {t("play.live.introTitle", { n: props.setNumber, title: props.setTitle })}
            </h1>
            <p className="text-base">{t("play.live.introBody", { count: props.questionCount })}</p>
            <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-3 text-base text-warning-soft-foreground">
              <WarningIcon aria-hidden="true" size={22} weight="fill" className="mt-0.5 shrink-0" />
              {t("play.live.introWarning")}
            </p>
            <Button variant="cta" size="lg" className="w-full" onClick={() => void start()}>
              {t("play.live.start")}
            </Button>
            <Button asChild variant="outline">
              <a href={backHref}>{t("play.backToSets")}</a>
            </Button>
          </div>
        </div>
      );
    case "loading":
      return (
        <div className="flex flex-col gap-4">
          {header(null, null)}
          <p role="status" className="rounded-xl border bg-card p-6 text-center text-base shadow-sm">
            {t("play.live.loading")}
          </p>
        </div>
      );
    case "closed":
      return notice(t("play.live.closedTitle"), t("play.live.closedBody"), <HourglassIcon aria-hidden="true" size={48} weight="duotone" className="text-primary" />);
    case "locked":
      return notice(t("play.live.lockedTitle"), t("play.live.lockedBody"), <LockSimpleIcon aria-hidden="true" size={48} weight="duotone" className="text-primary" />);
    case "error":
      return (
        <div className="flex flex-col gap-4">
          {header(null, null)}
          <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center shadow-md">
            <WarningIcon aria-hidden="true" size={48} weight="duotone" className="text-warning" />
            <h1 ref={setFocus} tabIndex={-1} className="font-heading text-2xl outline-none">
              {t("play.live.errorTitle")}
            </h1>
            <p className="text-base">{t("play.live.errorBody")}</p>
            <Button
              variant="cta"
              size="lg"
              className="w-full"
              onClick={() => {
                if (attemptId === null) {
                  setScreen({ kind: "intro" });
                } else {
                  setScreen({ kind: "loading" });
                  void loadCurrent(attemptId);
                }
              }}
            >
              {t("play.live.retry")}
            </Button>
            <Button asChild variant="outline">
              <a href={backHref}>{t("play.backToSets")}</a>
            </Button>
          </div>
        </div>
      );
    case "finished":
      return (
        <div className="reveal-in flex flex-col gap-4">
          <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center shadow-md">
            <TrophyIcon aria-hidden="true" size={48} weight="duotone" className="text-primary" />
            <h1 ref={setFocus} tabIndex={-1} className="font-heading text-2xl outline-none">
              {t("play.resultTitle")}
            </h1>
            <dl className="grid w-full grid-cols-3 gap-2">
              <div className="rounded-lg bg-muted px-2 py-2">
                <dt className="text-sm text-muted-foreground">{t("play.resultScore")}</dt>
                <dd className="text-xl font-semibold tabular">{formatNumber(screen.score)}</dd>
              </div>
              <div className="rounded-lg bg-muted px-2 py-2">
                <dt className="text-sm text-muted-foreground">{t("play.resultTime")}</dt>
                <dd className="text-xl font-semibold tabular">{formatMs(screen.totalMs)}</dd>
              </div>
              <div className="rounded-lg bg-muted px-2 py-2">
                <dt className="text-sm text-muted-foreground">{t("play.resultRank")}</dt>
                <dd className="font-heading text-xl tabular">{rank === null ? t("play.live.noRank") : `#${String(rank)}`}</dd>
              </div>
            </dl>
            <Button asChild variant="cta" size="lg" className="w-full">
              <a href={backHref}>{t("play.backToSets")}</a>
            </Button>
          </div>
        </div>
      );
    case "question":
    case "answering":
    case "answered":
    case "timeup":
      break;
  }

  const question = screen.q;
  const seconds = screen.kind === "question" ? Math.ceil(leftMs(question, clock) / 1000) : screen.kind === "timeup" ? 0 : screen.stoppedSeconds;
  const low = screen.kind === "question" && seconds <= LOW_SECONDS;
  const next = () => {
    if (attemptId === null) return;
    setScreen({ kind: "loading" });
    void loadCurrent(attemptId);
  };
  const nextLabel = question.position >= question.total ? t("play.seeResult") : t("play.next");
  const answered = screen.kind === "answered" ? screen : null;
  const chosen = screen.kind === "answering" || screen.kind === "answered" ? screen.chosen : null;
  const announce = screen.kind === "timeup" ? t("play.live.timeUp") : screen.kind === "question" && (seconds === 10 || seconds === LOW_SECONDS) ? t("play.timerLabel", { n: seconds }) : "";

  function toneOf(optionId: string): OptionTone {
    if (answered === null) return chosen === optionId ? "chosen" : "idle";
    if (chosen === optionId) return answered.result.correct ? "correct" : "wrong";
    if (answered.result.correctOptionId === optionId) return "reveal";
    return "dim";
  }

  return (
    <div className="flex flex-col gap-4">
      {header(question.position, question.total)}

      <div className="flex items-center gap-4 rounded-xl border bg-card p-3 shadow-sm">
        <Ring remaining={seconds} windowSeconds={Math.ceil(question.windowMs / 1000)} low={low} />
        <p className={cn("flex min-h-6 items-center gap-1.5 text-base font-semibold", low || screen.kind === "timeup" ? "text-warning" : "text-muted-foreground")}>
          {low ? <WarningIcon aria-hidden="true" size={20} weight="fill" /> : null}
          {screen.kind === "timeup" ? t("play.live.timeUp") : low ? t("play.timeLow") : <span className="font-medium">{t("play.timerLabel", { n: seconds })}</span>}
        </p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      {question.previousTimedOut && screen.kind === "question" ? (
        <p className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-base text-warning-soft-foreground">
          <HourglassIcon aria-hidden="true" size={20} weight="fill" />
          {t("play.live.previousTimedOut")}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-md md:p-6">
        <h1 ref={screen.kind === "question" ? setFocus : undefined} tabIndex={-1} className="max-w-[65ch] text-xl leading-normal font-semibold break-words outline-none">
          {question.prompt}
        </h1>
        <ul aria-label={t("play.options")} className="flex flex-col gap-3">
          {question.options.map((option, i) => {
            const tone = toneOf(option.id);
            const locked = screen.kind !== "question";
            return (
              <li key={option.id}>
                <button
                  type="button"
                  aria-disabled={locked ? "true" : undefined}
                  onClick={() => {
                    if (!locked) void choose(question, option.id);
                  }}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left text-lg font-medium transition-colors duration-(--duration-fast) focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    TONE_CLASS[tone],
                    locked && "cursor-default",
                  )}
                >
                  <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border-2 border-current font-heading text-base">
                    {LETTERS[i] ?? ""}
                  </span>
                  <span className="flex-1 break-words">{option.label}</span>
                  {tone === "correct" || tone === "wrong" ? (
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      {tone === "correct" ? <CheckCircleIcon aria-hidden="true" size={22} weight="fill" className="check-pop" /> : <XCircleIcon aria-hidden="true" size={22} weight="fill" />}
                      {t("play.yourAnswer")}
                    </span>
                  ) : null}
                  {tone === "reveal" ? (
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      <CheckCircleIcon aria-hidden="true" size={22} weight="fill" />
                      {t("play.correctAnswer")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Focus moves here with each result: no live region of its own, the focus reads it. */}
      <div ref={screen.kind === "answered" || screen.kind === "timeup" ? setFocus : undefined} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        {screen.kind === "answering" ? <p className="text-center text-base text-muted-foreground">{t("play.live.answering")}</p> : null}
        {screen.kind === "timeup" ? (
          <div className="reveal-in flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-xl bg-warning-soft px-4 py-3 text-lg font-semibold text-warning-soft-foreground">
              <HourglassIcon aria-hidden="true" size={28} weight="fill" />
              <span>{screen.tooLate ? t("play.live.tooLate") : t("play.timeout")}</span>
            </div>
            <Button variant="cta" size="lg" className="w-full" onClick={next}>
              {nextLabel}
            </Button>
          </div>
        ) : null}
        {answered === null ? null : (
          <div className="reveal-in flex flex-col gap-3">
            <div
              className={cn(
                "flex items-center gap-2 rounded-xl px-4 py-3 text-lg font-semibold",
                answered.result.correct ? "bg-success-soft text-success-soft-foreground" : "bg-destructive-soft text-destructive-soft-foreground",
              )}
            >
              {answered.result.correct ? <CheckCircleIcon aria-hidden="true" size={28} weight="fill" className="check-pop" /> : <XCircleIcon aria-hidden="true" size={28} weight="fill" />}
              <span>{answered.result.correct ? t("play.live.correctPoints", { points: answered.result.points }) : t("play.wrong")}</span>
            </div>
            {!answered.result.correct && answered.result.explanation !== null ? (
              <div className="rounded-xl border bg-card px-4 py-3">
                <h2 className="text-base font-semibold">{t("play.explanation")}</h2>
                <p className="max-w-[65ch] text-base break-words">{answered.result.explanation}</p>
              </div>
            ) : null}
            <Button variant="cta" size="lg" className="w-full" onClick={next}>
              {nextLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
