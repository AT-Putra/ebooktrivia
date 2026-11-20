"use server";
// Owner only (legal_page.edit, owner decision 2026-11-18). Every save is a new draft version;
// published versions are immutable and no version is ever deleted (database, ET073 / ET074).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { formValue, onlyFields, uuid } from "../../../../lib/settings/fields.ts";
import { LEGAL_LABEL, parseKind, parseLegalBody, parseLegalTitle, publishLegalPage, saveLegalDraft } from "../../../../lib/settings/legal.ts";

const PATH = "/settings/legal";

export const saveLegalDraftAction = adminAction({ permission: "legal_page.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "kind", "title", "body"]);
      const kind = parseKind(formValue(form, "kind"));
      const version = await saveLegalDraft(rt.sql, uuid(formValue(form, "programId")), kind, { title: parseLegalTitle(formValue(form, "title")), body: parseLegalBody(formValue(form, "body")) });
      return `${LEGAL_LABEL[kind]}: draft version ${String(version)} saved.`;
    },
    "layout",
  ),
);

export const publishLegalPageAction = adminAction({ permission: "legal_page.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["programId", "kind", "pageId"]);
      const kind = parseKind(formValue(form, "kind"));
      const version = await publishLegalPage(rt.sql, uuid(formValue(form, "programId")), kind, uuid(formValue(form, "pageId")));
      return `${LEGAL_LABEL[kind]}: version ${String(version)} published.`;
    },
    "layout",
  ),
);
