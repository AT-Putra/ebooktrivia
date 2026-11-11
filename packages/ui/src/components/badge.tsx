import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.ts";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-on-primary",
        secondary: "bg-secondary text-on-secondary",
        accent: "bg-accent text-on-accent",
        outline: "border border-input bg-card text-card-foreground",
        success: "bg-success-soft text-success-soft-foreground",
        warning: "bg-warning-soft text-warning-soft-foreground",
        info: "bg-info-soft text-info-soft-foreground",
        destructive: "bg-destructive-soft text-destructive-soft-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

/** Pair with a Phosphor icon and visible text so status never relies on colour alone. */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
