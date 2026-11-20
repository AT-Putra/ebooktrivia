"use server";
// Owner only (waha.edit: WAHA servers, their API keys and the private-IP allowlist, AC-A1).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { checkbox, formValue, uuid } from "../../../../lib/settings/fields.ts";
import { clearWahaApiKey, createWahaServer, createWahaSession, parseWahaServer, parseWahaSession, setWahaApiKey, updateWahaServer, updateWahaSession } from "../../../../lib/settings/waha.ts";

const PATH = "/settings/waha";

const serverInput = (form: FormData) =>
  parseWahaServer({ name: formValue(form, "name"), baseUrl: formValue(form, "baseUrl") }, { allowPrivateIp: checkbox(form, "allowPrivateIp"), active: checkbox(form, "active") });

const sessionInput = (form: FormData, serverId: string) =>
  parseWahaSession(
    { serverId, sessionName: formValue(form, "sessionName"), phone: formValue(form, "phone"), weight: formValue(form, "weight"), dailyCap: formValue(form, "dailyCap") },
    checkbox(form, "active"),
  );

export const createWahaServerAction = adminAction({ permission: "waha.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await createWahaServer(rt.sql, serverInput(form));
    return "Server added. Enter its API key next.";
  }),
);

export const updateWahaServerAction = adminAction({ permission: "waha.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const { keyCleared } = await updateWahaServer(rt.sql, uuid(formValue(form, "serverId")), serverInput(form));
    return keyCleared ? "Server saved. Its host changed, so the API key was removed: enter it again." : "Server saved.";
  }),
);

export const setWahaApiKeyAction = adminAction({ permission: "waha.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await setWahaApiKey(rt.sql, rt.settings, uuid(formValue(form, "serverId")), formValue(form, "apiKey"));
    return "API key saved.";
  }),
);

export const clearWahaApiKeyAction = adminAction({ permission: "waha.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await clearWahaApiKey(rt.sql, uuid(formValue(form, "serverId")));
    return "API key removed.";
  }),
);

export const createWahaSessionAction = adminAction({ permission: "waha.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await createWahaSession(rt.sql, sessionInput(form, uuid(formValue(form, "serverId"))));
    return "Session added.";
  }),
);

export const updateWahaSessionAction = adminAction({ permission: "waha.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const serverId = uuid(formValue(form, "serverId"));
    await updateWahaSession(rt.sql, uuid(formValue(form, "sessionId")), sessionInput(form, serverId));
    return "Session saved.";
  }),
);
