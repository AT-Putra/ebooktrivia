"use server";
// Prize fulfilment (US-030), Owner-only: the steps, a reasoned correction one step back, the notes (prize_fulfillment.update), and
// the revoke and re-award or reinstatement of a winner (winners.reaward). The database enforces the machine and audits every change
// (lib/settings/fulfillment.ts). Every form field is known: anything else is refused.
import type { SaveState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";
import { saveResult } from "../../../lib/next/settings-result.ts";
import { formValue, InvalidInput, onlyFields, uuid } from "../../../lib/settings/fields.ts";
import {
  moveFulfillment,
  parseCorrectionReason,
  parseNotes,
  parseStep,
  parseWinnerReason,
  reinstateWinner,
  revokeWinner,
  saveNotes,
  STEP_LABEL,
} from "../../../lib/settings/fulfillment.ts";

const PATH = "/fulfillment";
// A revoke or reinstatement also changes the contest results page (where the Owner resolves a winner before the confirmation): every page.
const WINNER_PATHS = "/";

/** One step forward from the status the Owner saw. */
export const advanceFulfillmentAction = adminAction({ permission: "prize_fulfillment.update" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["fulfillmentId", "from"]);
      const { to, changed } = await moveFulfillment(rt.sql, uuid(formValue(form, "fulfillmentId")), parseStep(formValue(form, "from")), "advance", null);
      return changed ? `Marked ${STEP_LABEL[to].toLowerCase()}.` : `Already ${STEP_LABEL[to].toLowerCase()}.`;
    },
    "layout",
  ),
);

/** One step back, with the reason (a mistake). Done is final. */
export const correctFulfillmentAction = adminAction({ permission: "prize_fulfillment.update" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["fulfillmentId", "from", "reason"]);
      const reason = parseCorrectionReason(form);
      const { to, changed } = await moveFulfillment(rt.sql, uuid(formValue(form, "fulfillmentId")), parseStep(formValue(form, "from")), "correct", reason);
      return changed ? `Moved back to ${STEP_LABEL[to].toLowerCase()}.` : `Already ${STEP_LABEL[to].toLowerCase()}.`;
    },
    "layout",
  ),
);

export const saveFulfillmentNotesAction = adminAction({ permission: "prize_fulfillment.update" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["fulfillmentId", "notes"]);
      const changed = await saveNotes(rt.sql, uuid(formValue(form, "fulfillmentId")), parseNotes(form));
      return changed ? "Notes saved." : "No change.";
    },
    "layout",
  ),
);

/** Revoke a winner (a chargeback, or the Owner's forfeit) and re-award the prize to the next eligible rank. */
export const revokeWinnerAction = adminAction({ permission: "winners.reaward" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    WINNER_PATHS,
    async () => {
      onlyFields(form, ["winnerId", "reason", "confirm"]);
      if (formValue(form, "confirm") !== "on") throw new InvalidInput("Tick the box to confirm the revoke.");
      const reason = parseWinnerReason(form);
      const { revoked, reawardedRank } = await revokeWinner(rt.sql, uuid(formValue(form, "winnerId")), reason);
      if (!revoked) return "This winner was already revoked.";
      return reawardedRank === null ? "Revoked. No eligible player is left to re-award the prize to." : `Revoked. The prize was re-awarded to the player ranked ${String(reawardedRank)}.`;
    },
    "layout",
  ),
);

/** Reinstate a flagged winner who is still paid (the chargeback was resolved). */
export const reinstateWinnerAction = adminAction({ permission: "winners.reaward" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    WINNER_PATHS,
    async () => {
      onlyFields(form, ["winnerId", "reason"]);
      const reason = parseWinnerReason(form);
      // Before the confirmation the winner awaits it again; after it, the fulfilment goes on.
      return (await reinstateWinner(rt.sql, uuid(formValue(form, "winnerId")), reason)) ? "Reinstated." : "This winner was already reinstated.";
    },
    "layout",
  ),
);
