"use server";
// Owner only (program.edit / program.reschedule, owner decision 2026-11-18). The field lock and the
// extend-only reschedule are checked in lib/settings/programs.ts and enforced by the database.
import { formValue, onlyFields, slug, singleLine, uuid } from "../../../../lib/settings/fields.ts";
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { cloneProgram, createProgram, graceDays, parseProgramForm, rescheduleProgram, setProgramBanner, setProgramStatus, updateProgram } from "../../../../lib/settings/programs.ts";

const PATH = "/settings/programs";

export const createProgramAction = adminAction({ permission: "program.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await createProgram(rt.sql, parseProgramForm(form));
    return "Program created as a draft.";
  }),
);

export const updateProgramAction = adminAction({ permission: "program.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await updateProgram(rt.sql, uuid(formValue(form, "programId")), parseProgramForm(form));
    return "Program saved.";
  }),
);

export const rescheduleProgramAction = adminAction({ permission: "program.reschedule" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await rescheduleProgram(rt.sql, uuid(formValue(form, "programId")), { lastDay: formValue(form, "lastDay"), graceDays: graceDays(formValue(form, "graceDays")) });
    return "Program rescheduled.";
  }),
);

export const setProgramStatusAction = adminAction({ permission: "program.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const status = formValue(form, "status") === "published" ? "published" : "draft";
    await setProgramStatus(rt.sql, uuid(formValue(form, "programId")), status);
    return status === "published" ? "Program published." : "Program moved back to draft.";
  }),
);

export const cloneProgramAction = adminAction({ permission: "program.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await cloneProgram(rt.sql, uuid(formValue(form, "programId")), {
      slug: slug(formValue(form, "slug"), "The new slug is lowercase letters, digits and single hyphens (up to 64)."),
      name: singleLine(formValue(form, "name"), "Enter a name for the copy (up to 120 characters).", { max: 120 }),
    });
    return "Program cloned as a draft.";
  }),
);

/** Back to the built-in banner art (the upload itself is /uploads/image/banner, lib/next/content-routes.ts). */
export const removeProgramBannerAction = adminAction({ permission: "program.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ["programId"]);
    await setProgramBanner(rt.sql, admin.userId, uuid(formValue(form, "programId")), null);
    return "Gambar banner dihapus.";
  }),
);
