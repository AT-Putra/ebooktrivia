"use client";

import { useEffect, useState } from "react";
import { formatHms } from "../lib/format.ts";

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

export function Countdown({ initialSeconds, className }: { initialSeconds: number; className?: string }) {
  const seconds = useRemaining(initialSeconds);
  return (
    <span role="timer" aria-live="off" className={className ?? "timer-digits"}>
      {formatHms(seconds)}
    </span>
  );
}

/** Sentence with a live countdown, e.g. "Set berikutnya terbuka dalam {countdown} WIB". */
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
