"use client";

// A settings form bound to one server action (US-017). Submits with fetch (no full-page post) and
// does not reset the fields, so a refused value can be corrected; shows the action's confirmation
// or error below the button.
//
// `confirm` makes it a two-step form for a destructive action: the first click only swaps the button, in place, for the
// warning, "Yes, delete" (the real submit) and "Cancel". Focus moves to Cancel when the warning opens and back to the
// button on Cancel or Escape, and stays there when "Yes, delete" is pressed (the button, aria-disabled while the action runs, is
// still focusable), so the keyboard never loses its place and a refusal is read from where it already is. No native dialog.
//
// `resetOnSuccess` empties the fields after a saved result (a form that adds something: a second press must not add the same thing again); `describedBy` is
// the id of what the button is about (a list of the same button for many items: the name of the item).
import { type KeyboardEvent as ReactKeyboardEvent, type SubmitEvent as ReactSubmitEvent, type ReactNode, startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
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
  confirm,
  resetOnSuccess,
  describedBy,
}: {
  action: (previous: SaveState, form: FormData) => Promise<SaveState>;
  submitLabel: string;
  children?: ReactNode | undefined;
  className?: string | undefined;
  variant?: "cta" | "secondary" | "outline" | "destructive" | "ghost" | undefined;
  testId?: string | undefined;
  /** The warning shown before the action runs (and the label of the real submit button, "Yes, delete" by default). */
  confirm?: { readonly warning: string; readonly yesLabel?: string } | undefined;
  resetOnSuccess?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  const [state, dispatch, pending] = useActionState(action, INITIAL_SAVE);
  const [confirming, setConfirming] = useState(false);
  const warningId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const asking = confirm !== undefined && confirming;
  useEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);
  useEffect(() => {
    if (resetOnSuccess === true && state.status === "saved") formRef.current?.reset();
  }, [state, resetOnSuccess]);
  const close = () => {
    returnFocus.current = true;
    setConfirming(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (asking && event.key === "Escape") close();
  };
  const onSubmit = (event: ReactSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A two-step form submits only from its "Yes" button.
    if (confirm !== undefined && !confirming) return;
    // The "Yes" button is about to go away: keep the keyboard on this form (the trigger is back, still focusable while the action runs),
    // so a refusal that comes back is read from where the focus already is.
    if (confirm !== undefined) returnFocus.current = true;
    setConfirming(false);
    const submitter = event.nativeEvent.submitter;
    const data = new FormData(event.currentTarget, submitter instanceof HTMLElement ? submitter : null);
    startTransition(() => {
      dispatch(data);
    });
  };
  return (
    <form ref={formRef} onSubmit={onSubmit} className={className ?? "flex flex-col gap-3"} data-testid={testId}>
      {children}
      {asking ? (
        <p id={warningId} className="text-sm">
          {confirm.warning}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3" role={asking ? "group" : undefined} aria-labelledby={asking ? warningId : undefined} onKeyDown={onKeyDown}>
        {asking ? (
          <>
            <Button type="submit" variant="destructive" size="sm" disabled={pending}>
              {confirm.yesLabel ?? "Yes, delete"}
            </Button>
            <Button type="button" variant="outline" size="sm" ref={cancel} onClick={close}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type={confirm === undefined ? "submit" : "button"}
            variant={variant}
            size="sm"
            // A two-step trigger stays focusable while the action runs (aria-disabled, and the click is ignored): a disabled button would drop the focus.
            disabled={confirm === undefined ? pending : undefined}
            aria-disabled={confirm !== undefined && pending ? true : undefined}
            aria-describedby={describedBy}
            ref={trigger}
            onClick={
              confirm === undefined
                ? undefined
                : () => {
                    if (!pending) setConfirming(true);
                  }
            }
          >
            {submitLabel}
          </Button>
        )}
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
