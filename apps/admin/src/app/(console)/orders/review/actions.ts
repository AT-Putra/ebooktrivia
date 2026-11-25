"use server";
// The Owner's review queue for orders (US-033). Every action is Owner-only (order.review.resolve; a Staff session gets 403 from
// adminAction before the body runs) and POST with the Origin check of lib/next/actions.ts:
//   decideReviewAction    "mark paid" / "not paid": typed confirmation, reason and a request key per rendered form; the database
//                         function public.order_review_decide does the rest (lib/review/review.ts) and writes the audit row;
//   requeryReviewAction   "re-query Midtrans now": one outbox row for the worker's normal payment path; audited.
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { decideReview, decisionMessage, parseDecision, requestRequery, REVIEW_PATH } from "../../../../lib/review/review.ts";
import { formValue, onlyFields, uuid } from "../../../../lib/settings/fields.ts";

export const decideReviewAction = adminAction({ permission: "order.review.resolve" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(REVIEW_PATH, async () => {
    onlyFields(form, ["id", "decision", "confirm", "reason", "key"]);
    const input = parseDecision({
      id: formValue(form, "id"),
      decision: formValue(form, "decision"),
      confirm: formValue(form, "confirm"),
      reason: formValue(form, "reason"),
      key: formValue(form, "key"),
    });
    return decisionMessage(await decideReview(rt.sql, input));
  }),
);

export const requeryReviewAction = adminAction({ permission: "order.review.resolve" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(REVIEW_PATH, async () => {
    onlyFields(form, ["id", "key"]);
    const queued = await requestRequery(rt.sql, uuid(formValue(form, "id")), uuid(formValue(form, "key"), "The form is out of date. Reload the page and try again."));
    return queued
      ? "Re-query asked: the worker asks Midtrans about every attempt within a minute. Reload the page to see the answer."
      : "A re-query of this order is already running. Reload the page in a minute to see the answer.";
  }),
);
