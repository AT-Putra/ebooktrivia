import type { ReactNode } from "react";
import { cn } from "@ebooktrivia/ui/lib/utils";

interface TriviaCardProps {
  titleId: string;
  className?: string;
  children: ReactNode;
}

/** Card chrome from pages/trivia.md: not clickable as a whole, no hover lift. */
export function TriviaCard({ titleId, className, children }: TriviaCardProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-md md:p-6", className)}
    >
      {children}
    </section>
  );
}

interface CardHeadingProps {
  id: string;
  level?: "h1" | "h2";
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}

export function CardHeading({ id, level = "h2", icon, children, action }: CardHeadingProps) {
  const Heading = level;
  return (
    // The action drops below the title only when the title's longest word and the action do not fit side by side (a 320 px phone):
    // the title's flex basis is its min-content, so the line breaks on that, and it grows to push the action to the right otherwise.
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 grow basis-[min-content] items-center gap-2">
        <span aria-hidden="true" className="shrink-0 text-primary">
          {icon}
        </span>
        <Heading id={id} className="font-heading text-xl leading-tight">
          {children}
        </Heading>
      </div>
      {action}
    </header>
  );
}
