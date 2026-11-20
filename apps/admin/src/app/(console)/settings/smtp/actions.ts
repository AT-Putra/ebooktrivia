"use server";
// Owner only (smtp.edit: the SMTP server and its password, AC-A1).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { checkbox, formValue } from "../../../../lib/settings/fields.ts";
import { clearSmtpPassword, parseSmtp, saveSmtp, setSmtpPassword } from "../../../../lib/settings/smtp.ts";

const PATH = "/settings/smtp";

export const saveSmtpAction = adminAction({ permission: "smtp.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const input = parseSmtp(
      {
        host: formValue(form, "host"),
        port: formValue(form, "port"),
        security: formValue(form, "security"),
        username: formValue(form, "username"),
        fromAddress: formValue(form, "fromAddress"),
        fromName: formValue(form, "fromName"),
      },
      checkbox(form, "allowPrivateIp"),
    );
    const { passwordCleared } = await saveSmtp(rt.sql, input);
    return passwordCleared ? "SMTP server saved. The host changed, so the password was removed: enter it again." : "SMTP server saved.";
  }),
);

export const setSmtpPasswordAction = adminAction({ permission: "smtp.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await setSmtpPassword(rt.sql, rt.settings, formValue(form, "password"));
    return "Password saved.";
  }),
);

export const clearSmtpPasswordAction = adminAction({ permission: "smtp.edit" }, async ({ rt }): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await clearSmtpPassword(rt.sql);
    return "Password removed.";
  }),
);
