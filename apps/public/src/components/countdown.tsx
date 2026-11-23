"use client";

import { useEffect, useState } from "react";
import { formatHms, splitDaysHms } from "../lib/format.ts";

/** Ticks down once per second. Fixed-width tabular digits so nothing shifts. */
function useRemaining(initialSeconds: number): number {
  const [seconds, setSeconds] = useState(initialSeconds);
  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((s) => Math.max(0, s - 1));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return seconds;
}

/**
 * The time left as whole days, then hh:mm:ss ("89 hari 04:18:22", or just "04:18:22" under a day), so a long wait never reads as
 * thousands of hours; `dayLabel` is the unit ("hari"). The digits are tabular, so nothing jiggles. Not a live region (aria-live
 * off): a screen reader reads it when asked, not every second.
 */
export function Countdown({ initialSeconds, dayLabel, className }: { initialSeconds: number; dayLabel: string; className?: string }) {
  const seconds = useRemaining(initialSeconds);
  const { days, hms } = splitDaysHms(seconds);
  return (
    <span role="timer" aria-live="off" className={className ?? "timer-digits"}>
      {days > 0 ? (
        <>
          {days} <span className="text-base font-semibold">{dayLabel}</span>{" "}
        </>
      ) : null}
      {hms}
    </span>
  );
}

/** Sentence with a live countdown, e.g. "Set berikutnya terbuka dalam {countdown}". */
export function CountdownText({ initialSeconds, template }: { initialSeconds: number; template: string }) {
  const seconds = useRemaining(initialSeconds);
  const [before = "", after = ""] = template.split("{countdown}");
  return (
    <span>
      {before}
      <span role="timer" aria-live="off" className="timer-digits font-semibold">
        {formatHms(seconds)}
      </span>
      {after}
    </span>
  );
}
