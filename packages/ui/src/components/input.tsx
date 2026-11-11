import * as React from "react";
import { cn } from "../lib/utils.ts";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-11 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 py-2 text-base text-card-foreground transition-colors duration-(--duration-base) placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
