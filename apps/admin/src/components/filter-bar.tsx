"use client";

import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";

interface Field {
  id: string;
  label: string;
  options: string[];
}

const FIELDS: Field[] = [
  { id: "range", label: "Date range (WIB)", options: ["Today", "7 days", "30 days", "This month", "Custom"] },
  { id: "program", label: "Program", options: ["All programs", "Trivia Nusantara Juara", "Kuis Sains Ceria"] },
  { id: "landing", label: "Landing page", options: ["All pages", "lp-nusantara-juara", "lp-sains-ceria", "lp-juara-sekolah"] },
  { id: "adnet", label: "Adnet", options: ["All adnets", "Alpha Ads", "Beta Media", "Gamma Click", "Direct"] },
  { id: "gateway", label: "Gateway", options: ["All gateways", "Midtrans", "Xendit"] },
  { id: "status", label: "Status", options: ["All statuses", "Paid", "Pending", "Failed", "Refunded"] },
];

interface Chip {
  id: string;
  text: string;
}

const INITIAL_CHIPS: Chip[] = [
  { id: "gateway", text: "Gateway = Midtrans" },
  { id: "status", text: "Status = Paid" },
];

/** Filters apply on Apply, not per keystroke; the result count is announced once. */
export function FilterBar() {
  const [chips, setChips] = useState(INITIAL_CHIPS);
  const [announce, setAnnounce] = useState("");

  return (
    <section aria-label="Filters" className="sticky top-(--topbar-h) z-(--z-sticky) rounded-lg border bg-card p-2 shadow-sm">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setAnnounce("2,340 results");
        }}
      >
        {FIELDS.map((f) => (
          <div key={f.id} className="flex min-w-36 flex-1 flex-col gap-0.5">
            <label htmlFor={`f-${f.id}`} className="text-xs font-medium text-muted-foreground">
              {f.label}
            </label>
            <select
              id={`f-${f.id}`}
              name={f.id}
              defaultValue={f.id === "range" ? "30 days" : f.options[f.id === "gateway" ? 1 : f.id === "status" ? 1 : 0]}
              className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button type="reset" variant="ghost" size="sm" className="min-h-9" onClick={() => {
            setChips([]);
            setAnnounce("");
          }}>
            Reset
          </Button>
          <Button type="submit" size="sm" className="min-h-9">
            Apply
          </Button>
        </div>
      </form>
      {chips.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.id} className="flex items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-xs font-medium">
              {c.text}
              <button
                type="button"
                aria-label={`Remove filter: ${c.text}`}
                onClick={() => {
                  setChips((all) => all.filter((x) => x.id !== c.id));
                }}
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground"
              >
                <XIcon aria-hidden="true" size={12} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </section>
  );
}
