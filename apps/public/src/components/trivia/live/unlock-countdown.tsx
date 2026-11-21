"use client";

// The next-unlock countdown (US-027, AC-Q4): "Set berikutnya terbuka dalam hh:mm:ss" (a duration: the WIB instant
// is the line below it, "Tepatnya ..., pukul 00.00 WIB"), ticking once a second
// from the seconds the server computed with the database's clock. At zero the page reloads once, so the grid
// shows the set that just opened (a page load is one of the leaderboard's refresh points too). aria-live off: a
// screen reader reads it when asked, it does not announce every second.
import { useEffect, useState } from "react";
import { formatHms } from "../../../lib/format.ts";

export function UnlockCountdown({ initialSeconds, template }: { readonly initialSeconds: number; readonly template: string }) {
  const [seconds, setSeconds] = useState(initialSeconds);
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      const left = Math.max(0, initialSeconds - Math.floor((Date.now() - startedAt) / 1000));
      setSeconds(left);
      if (left === 0) {
        clearInterval(id);
        // A short margin past 00:00 WIB, so the server's clock has passed it too.
        window.setTimeout(() => {
          window.location.reload();
        }, 1500);
      }
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [initialSeconds]);
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
