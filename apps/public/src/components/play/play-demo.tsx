"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  HourglassIcon,
  TrophyIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@ebooktrivia/ui/components/dialog";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { formatMinSec, formatNumber } from "../../lib/format.ts";
import { QUESTION_SECONDS, QUESTIONS } from "../../lib/play-fixtures.ts";
import { t } from "../../lib/t.ts";

export type StaticState = "correct" | "wrong" | "timeout";
type Outcome = StaticState | null;

const LETTERS = ["A", "B", "C", "D"] as const;
const RING_RADIUS = 28;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const LOW_SECONDS = 5;

interface Snapshot {
  outcome: Outcome;
  chosen: number | null;
  remaining: number;
}

function snapshotFor(state: StaticState | undefined): Snapshot {
  const q = QUESTIONS[0];
  if (q === undefined) throw new Error("no questions");
  switch (state) {
    case "correct":
      return { outcome: "correct", chosen: q.answer, remaining: 14 };
    case "wrong":
      return { outcome: "wrong", chosen: (q.answer + 1) % q.options.length, remaining: 11 };
    case "timeout":
      return { outcome: "timeout", chosen: null, remaining: 0 };
    case undefined:
      return { outcome: null, chosen: null, remaining: QUESTION_SECONDS };
  }
}

function Ring({ remaining, low }: { remaining: number; low: boolean }) {
  const offset = RING_LENGTH * (1 - remaining / QUESTION_SECONDS);
  return (
    <div
      role="timer"
      aria-live="off"
      aria-label={t("play.timerLabel", { n: remaining })}
      className="relative size-16 shrink-0"
    >
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
          className={cn(
            "transition-[stroke-dashoffset] duration-1000 ease-linear",
            low ? "stroke-warning" : "stroke-primary",
          )}
        />
      </svg>
      <span
        aria-hidden="true"
        className={cn(
          "timer-digits absolute inset-0 flex items-center justify-center text-xl",
          low ? "font-bold text-warning" : "font-semibold",
        )}
      >
        <span className="inline-block w-[2ch] text-center">{remaining}</span>
      </span>
    </div>
  );
}

type OptionTone = "idle" | "correct" | "wrong" | "reveal" | "dim";

const TONE_CLASS: Record<OptionTone, string> = {
  idle: "border-input bg-card text-card-foreground hover:bg-muted",
  correct: "border-success bg-success text-on-success",
  wrong: "border-destructive bg-destructive-soft text-destructive-soft-foreground",
  reveal: "border-success bg-success-soft text-success-soft-foreground",
  dim: "border-border bg-muted text-muted-foreground",
};

export function PlayDemo({ setNumber, initialState }: { setNumber: number; initialState?: StaticState }) {
  const frozen = initialState !== undefined;
  const start = snapshotFor(initialState);
  const [index, setIndex] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>(start.outcome);
  const [chosen, setChosen] = useState<number | null>(start.chosen);
  const [remaining, setRemaining] = useState(start.remaining);
  const [finished, setFinished] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const resultRef = useRef<HTMLDivElement>(null);

  const question = QUESTIONS[index];
  const answered = outcome !== null;
  const last = index === QUESTIONS.length - 1;
  const low = remaining > 0 && remaining <= LOW_SECONDS && !answered;

  useEffect(() => {
    if (frozen || answered || finished) return;
    const id = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [frozen, answered, finished, index]);

  useEffect(() => {
    if (!frozen && !answered && !finished && remaining === 0) setOutcome("timeout");
  }, [frozen, answered, finished, remaining]);

  useEffect(() => {
    if (!frozen && answered) resultRef.current?.focus();
  }, [frozen, answered]);

  if (question === undefined) return null;

  function choose(i: number) {
    if (answered || question === undefined) return;
    setChosen(i);
    const correct = i === question.answer;
    setOutcome(correct ? "correct" : "wrong");
    if (correct) setCorrectCount((c) => c + 1);
  }

  function next() {
    if (last) {
      setFinished(true);
      return;
    }
    setIndex((i) => i + 1);
    setOutcome(null);
    setChosen(null);
    setRemaining(QUESTION_SECONDS);
  }

  function toneOf(i: number): OptionTone {
    if (!answered) return "idle";
    if (chosen === i) return outcome === "correct" ? "correct" : "wrong";
    if (question?.answer === i) return "reveal";
    return "dim";
  }

  const announce = !answered && (remaining === 10 || remaining === LOW_SECONDS) ? t("play.timerLabel", { n: remaining }) : "";

  if (finished) {
    return (
      <div className="reveal-in flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center shadow-md">
          <TrophyIcon aria-hidden="true" size={48} weight="duotone" className="text-primary" />
          <h1 className="font-heading text-2xl">{t("play.resultTitle")}</h1>
          <dl className="grid w-full grid-cols-3 gap-2">
            <div className="rounded-lg bg-muted px-2 py-2">
              <dt className="text-sm text-muted-foreground">{t("play.resultScore")}</dt>
              <dd className="text-xl font-semibold tabular">{formatNumber(correctCount * 10)}</dd>
            </div>
            <div className="rounded-lg bg-muted px-2 py-2">
              <dt className="text-sm text-muted-foreground">{t("play.resultTime")}</dt>
              <dd className="text-xl font-semibold tabular">{formatMinSec(74)}</dd>
            </div>
            <div className="rounded-lg bg-muted px-2 py-2">
              <dt className="text-sm text-muted-foreground">{t("play.resultRank")}</dt>
              <dd className="font-heading text-xl tabular">#47</dd>
            </div>
          </dl>
          <Button asChild variant="cta" size="lg" className="w-full">
            <a href="/mockups/trivia">{t("play.backToSets")}</a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-heading text-2xl">{t("play.title", { n: setNumber })}</p>
          <div className="flex items-center gap-2">
            <progress
              value={index + 1}
              max={QUESTIONS.length}
              aria-label={t("play.progress", { current: index + 1, total: QUESTIONS.length })}
              className="h-2 w-full max-w-40 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
            />
            <p className="text-sm font-medium text-muted-foreground tabular">
              {t("play.progress", { current: index + 1, total: QUESTIONS.length })}
            </p>
          </div>
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
                <a href="/mockups/trivia">{t("play.exit")}</a>
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      <div className="flex items-center gap-4 rounded-xl border bg-card p-3 shadow-sm">
        <Ring remaining={remaining} low={low} />
        <p
          className={cn(
            "flex min-h-6 items-center gap-1.5 text-base font-semibold",
            low || outcome === "timeout" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {low ? <WarningIcon aria-hidden="true" size={20} weight="fill" /> : null}
          {low ? t("play.timeLow") : <span className="font-medium">{t("play.timerLabel", { n: remaining })}</span>}
        </p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-md md:p-6">
        <h1 className="max-w-[65ch] text-xl leading-normal font-semibold">{question.text}</h1>
        <ul aria-label={t("play.options")} className="flex flex-col gap-3">
          {question.options.map((option, i) => {
            const tone = toneOf(i);
            return (
              <li key={option}>
                <button
                  type="button"
                  aria-disabled={answered ? "true" : undefined}
                  onClick={() => {
                    choose(i);
                  }}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left text-lg font-medium transition-colors duration-(--duration-fast) focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    TONE_CLASS[tone],
                    answered && "cursor-default",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg border-2 border-current font-heading text-base",
                    )}
                  >
                    {LETTERS[i]}
                  </span>
                  <span className="flex-1">{option}</span>
                  {tone === "correct" ? (
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      <CheckCircleIcon aria-hidden="true" size={22} weight="fill" className="check-pop" />
                      {t("play.yourAnswer")}
                    </span>
                  ) : null}
                  {tone === "wrong" ? (
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      <XCircleIcon aria-hidden="true" size={22} weight="fill" />
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

      <div ref={resultRef} tabIndex={-1} role="status" aria-live="polite" className="flex flex-col gap-3 outline-none">
        {answered ? (
          <div className="reveal-in flex flex-col gap-3">
            <div
              className={cn(
                "flex items-center gap-2 rounded-xl px-4 py-3 text-lg font-semibold",
                outcome === "correct" && "bg-success-soft text-success-soft-foreground",
                outcome === "wrong" && "bg-destructive-soft text-destructive-soft-foreground",
                outcome === "timeout" && "bg-warning-soft text-warning-soft-foreground",
              )}
            >
              {outcome === "correct" ? <CheckCircleIcon aria-hidden="true" size={28} weight="fill" className="check-pop" /> : null}
              {outcome === "wrong" ? <XCircleIcon aria-hidden="true" size={28} weight="fill" /> : null}
              {outcome === "timeout" ? <HourglassIcon aria-hidden="true" size={28} weight="fill" /> : null}
              <span>
                {outcome === "correct" ? t("play.correct") : outcome === "wrong" ? t("play.wrong") : t("play.timeout")}
              </span>
            </div>
            {outcome !== "correct" ? (
              <div className="rounded-xl border bg-card px-4 py-3">
                <h2 className="text-base font-semibold">{t("play.explanation")}</h2>
                <p className="max-w-[65ch] text-base">{question.explanation}</p>
              </div>
            ) : null}
            <Button variant="cta" size="lg" className="w-full" onClick={next}>
              {last ? t("play.seeResult") : t("play.next")}
            </Button>
          </div>
        ) : null}
      </div>
      <p className="text-center text-sm text-muted-foreground">{t("play.demoNote")}</p>
    </div>
  );
}
