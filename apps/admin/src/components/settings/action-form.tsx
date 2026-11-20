"use client";

// A settings form bound to one server action (US-017). Submits with fetch (no full-page post) and
// does not reset the fields, so a refused value can be corrected; shows the action's confirmation
// or error below the button.
import { type SubmitEvent as ReactSubmitEvent, type ReactNode, startTransition, useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { INITIAL_SAVE, type SaveState } from "../../lib/form-state.ts";
import { FormError } from "../auth/auth-card.tsx";

export function ActionForm({
  action,
  submitLabel,
  children,
  className,
  variant = "cta",
  testId,
}: {
  action: (previous: SaveState, form: FormData) => Promise<SaveState>;
  submitLabel: string;
  children?: ReactNode | undefined;
  className?: string | undefined;
  variant?: "cta" | "secondary" | "outline" | "destructive" | "ghost" | undefined;
  testId?: string | undefined;
}) {
  const [state, dispatch, pending] = useActionState(action, INITIAL_SAVE);
  const onSubmit = (event: ReactSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = event.nativeEvent.submitter;
    const data = new FormData(event.currentTarget, submitter instanceof HTMLElement ? submitter : null);
    startTransition(() => {
      dispatch(data);
    });
  };
  return (
    <form onSubmit={onSubmit} className={className ?? "flex flex-col gap-3"} data-testid={testId}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} size="sm" disabled={pending}>
          {submitLabel}
        </Button>
        {state.status === "saved" ? (
          <p role="status" className="text-sm" key={state.at}>
            {state.message}
          </p>
        ) : null}
      </div>
      {state.status === "error" ? <FormError key={state.at}>{state.error}</FormError> : null}
    </form>
  );
}
