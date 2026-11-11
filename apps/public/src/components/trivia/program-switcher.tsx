"use client";

import { useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@ebooktrivia/ui/components/dialog";
import { cn } from "@ebooktrivia/ui/lib/utils";
import type { Program } from "../../lib/trivia-fixtures.ts";
import { t } from "../../lib/t.ts";

interface ProgramSwitcherProps {
  programs: Program[];
  currentSlug: string;
  basePath: string;
}

/** Mobile: bottom-sheet dialog. >= 768: segmented nav. Selected program lives in ?program=slug. */
export function ProgramSwitcher({ programs, currentSlug, basePath }: ProgramSwitcherProps) {
  const [open, setOpen] = useState(false);
  const current = programs.find((p) => p.slug === currentSlug) ?? programs[0];
  if (current === undefined) return null;
  const href = (slug: string) => `${basePath}?program=${slug}`;

  return (
    <>
      <div className="md:hidden">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              <span className="truncate">{current.name}</span>
              <CaretDownIcon aria-hidden="true" size={18} weight="bold" />
              <span className="sr-only">{t("trivia.programSwitcher")}</span>
            </Button>
          </DialogTrigger>
          <DialogContent
            closeLabel={t("trivia.close")}
            className="top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 rounded-b-none"
          >
            <DialogHeader>
              <DialogTitle>{t("trivia.pickProgram")}</DialogTitle>
              <DialogDescription>{t("trivia.programSwitcher")}</DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-2">
              {programs.map((p) => (
                <li key={p.slug}>
                  <a
                    href={href(p.slug)}
                    aria-current={p.slug === current.slug ? "true" : undefined}
                    className="flex min-h-14 items-center justify-between gap-3 rounded-lg border-2 border-input px-4 py-2 transition-colors duration-(--duration-base) hover:bg-muted aria-[current=true]:border-primary aria-[current=true]:bg-muted"
                  >
                    <span className="flex flex-col">
                      <span className="font-semibold">{p.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {t("trivia.programProgress", { done: p.done, total: p.total })}
                      </span>
                    </span>
                    {p.slug === current.slug ? <CheckIcon aria-hidden="true" size={20} weight="bold" /> : null}
                  </a>
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>
      </div>

      <nav aria-label={t("trivia.programSwitcherNav")} className="hidden md:block">
        <ul className="flex gap-1 rounded-xl bg-muted p-1">
          {programs.map((p) => {
            const active = p.slug === current.slug;
            return (
              <li key={p.slug}>
                <a
                  href={href(p.slug)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 flex-col justify-center rounded-lg px-4 py-1 leading-tight transition-colors duration-(--duration-base)",
                    active ? "bg-primary text-on-primary" : "text-foreground hover:bg-card",
                  )}
                >
                  <span className="text-sm font-semibold">{p.name}</span>
                  <span className={cn("text-xs", active ? "text-on-primary" : "text-muted-foreground")}>
                    {t("trivia.programProgress", { done: p.done, total: p.total })}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
