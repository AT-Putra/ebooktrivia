"use server";
// Trivia sets and questions (manage trivia: Staff and Owner, AC-A1). The content lock is decided in
// lib/settings/trivia.ts inside each change's transaction (Staff on a set with attempts -> 403) and
// enforced by the database for every writer (ET020). The scoring override is the Owner's
// (rescore.override, lib/settings/rescore.ts). Every form field is known: anything else is refused.
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { formValue, InvalidInput, onlyFields, uuid, wholeNumber } from "../../../../lib/settings/fields.ts";
import { overrideQuestion, parseReason } from "../../../../lib/settings/rescore.ts";
import {
  createQuestion,
  createSet,
  deleteQuestion,
  deleteSet,
  getTriviaProgram,
  moveSet,
  parseCorrect,
  parseNewQuestion,
  parseQuestionEdit,
  parseSetTitle,
  QUESTION_FORM_FIELDS,
  renameSet,
  setQuestionImage,
  setSetThumbnail,
  TRIVIA_LIMITS,
  updateQuestion,
} from "../../../../lib/settings/trivia.ts";

const PATH = "/settings/trivia";

const setIds = (form: FormData) => ({ programId: uuid(formValue(form, "programId")), setId: uuid(formValue(form, "setId")) });
const questionIds = (form: FormData) => ({ ...setIds(form), questionId: uuid(formValue(form, "questionId")) });

export const createSetAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "title"]);
      await createSet(rt.sql, uuid(formValue(form, "programId")), parseSetTitle(formValue(form, "title")));
      return "Trivia set added.";
    },
    "layout",
  ),
);

export const renameSetAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId", "title"]);
      const { programId, setId } = setIds(form);
      await renameSet(rt.sql, admin, programId, setId, parseSetTitle(formValue(form, "title")));
      return "Title saved.";
    },
    "layout",
  ),
);

export const moveSetAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId", "direction"]);
      const { programId, setId } = setIds(form);
      const direction = formValue(form, "direction");
      if (direction !== "up" && direction !== "down") throw new InvalidInput("Choose up or down.");
      await moveSet(rt.sql, admin, programId, setId, direction);
      return direction === "up" ? "Set moved up." : "Set moved down.";
    },
    "layout",
  ),
);

export const deleteSetAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId"]);
      const { programId, setId } = setIds(form);
      await deleteSet(rt.sql, admin, programId, setId);
      return "Trivia set deleted.";
    },
    "layout",
  ),
);

export const removeSetThumbnailAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId"]);
      const { programId, setId } = setIds(form);
      await setSetThumbnail(rt.sql, admin, programId, setId, null);
      return "Thumbnail removed.";
    },
    "layout",
  ),
);

export const createQuestionAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, QUESTION_FORM_FIELDS.filter((f) => f !== "questionId"));
      const { programId, setId } = setIds(form);
      const program = await getTriviaProgram(rt.sql, programId);
      if (program === null) throw new InvalidInput("This program no longer exists.");
      await createQuestion(rt.sql, admin, programId, setId, parseNewQuestion(form, { points: program.defaultPoints, timerSeconds: program.defaultTimerSeconds }));
      return "Question added.";
    },
    "layout",
  ),
);

export const updateQuestionAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, QUESTION_FORM_FIELDS);
      await updateQuestion(rt.sql, admin, questionIds(form), parseQuestionEdit(form));
      return "Question saved.";
    },
    "layout",
  ),
);

export const deleteQuestionAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId", "questionId"]);
      await deleteQuestion(rt.sql, admin, questionIds(form));
      return "Question deleted.";
    },
    "layout",
  ),
);

export const removeQuestionImageAction = adminAction({ permission: "trivia_set.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId", "questionId"]);
      await setQuestionImage(rt.sql, admin, questionIds(form), null);
      return "Image removed.";
    },
    "layout",
  ),
);

/** Owner only: points, timer or the correct option of a question in a set with attempts, re-scored at once. */
export const overrideScoringAction = adminAction({ permission: "rescore.override" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "setId", "questionId", "points", "timerSeconds", "correct", "reason", "confirm"]);
      if (formValue(form, "confirm") !== "on") throw new InvalidInput("Tick the box to confirm the re-score.");
      const summary = await overrideQuestion(rt.sql, {
        ...questionIds(form),
        points: wholeNumber(formValue(form, "points"), `Points are a whole number from ${String(TRIVIA_LIMITS.points.min)} to ${String(TRIVIA_LIMITS.points.max)}.`, TRIVIA_LIMITS.points),
        timerSeconds: wholeNumber(formValue(form, "timerSeconds"), `The timer is a whole number of seconds from ${String(TRIVIA_LIMITS.timer.min)} to ${String(TRIVIA_LIMITS.timer.max)}.`, TRIVIA_LIMITS.timer),
        correct: parseCorrect(formValue(form, "correct"), 4),
        reason: parseReason(formValue(form, "reason")),
      });
      return `Re-scored ${String(summary.players)} player${summary.players === 1 ? "" : "s"}: ${String(summary.answersChanged)} answer${summary.answersChanged === 1 ? "" : "s"} changed, total score ${String(summary.scoreBefore)} to ${String(summary.scoreAfter)}.`;
    },
    "layout",
  ),
);
