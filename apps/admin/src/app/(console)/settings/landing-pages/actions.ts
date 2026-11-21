"use server";
// Create / program / active / adnets: Owner (landing_page.settings.edit). Name: Staff too
// (landing_page.content.edit). Pixel ids: Owner (pixel.edit). Domains: Owner (lp_domain.register,
// plan §10 item 18), with the registrable-domain check of lib/settings/lp-domains.ts. Hosted ZIP
// versions: Owner (lp_zip.publish, US-023). A change to what is served (domains, active, the live
// version) re-links /srv/lp/hosts right after its commit (lib/settings/lp-hosting.ts).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { clearCapiToken, parseCapiPlatform, setCapiToken } from "../../../../lib/settings/conversions.ts";
import { checkbox, formValue, uuid } from "../../../../lib/settings/fields.ts";
import { activateLpVersion, stopLpHosting, syncLpHostsQuietly } from "../../../../lib/settings/lp-hosting.ts";
import { createLandingPage, parseLpName, parsePixels, registerDomain, removeDomain, renameLandingPage, updateLandingPageSettings, updatePixels } from "../../../../lib/settings/landing-pages.ts";

const PATH = "/settings/landing-pages";

export const createLandingPageAction = adminAction({ permission: "landing_page.settings.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await createLandingPage(rt.sql, { name: parseLpName(formValue(form, "name")), programId: uuid(formValue(form, "programId"), "Choose the program.") });
    return "Landing page created.";
  }),
);

export const renameLandingPageAction = adminAction({ permission: "landing_page.content.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await renameLandingPage(rt.sql, uuid(formValue(form, "landingPageId")), parseLpName(formValue(form, "name")));
    return "Name saved.";
  }),
);

export const updateLandingPageSettingsAction = adminAction({ permission: "landing_page.settings.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const adnetIds = form.getAll("adnetId").map((v) => uuid(typeof v === "string" ? v : ""));
    await updateLandingPageSettings(rt.sql, uuid(formValue(form, "landingPageId")), {
      programId: uuid(formValue(form, "programId"), "Choose the program."),
      active: checkbox(form, "active"),
      adnetIds,
    });
    await syncLpHostsQuietly(rt.sql, rt.settings);
    return "Landing page settings saved.";
  }),
);

export const updatePixelsAction = adminAction({ permission: "pixel.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await updatePixels(
      rt.sql,
      uuid(formValue(form, "landingPageId")),
      parsePixels({ meta: formValue(form, "meta"), tiktok: formValue(form, "tiktok"), gtag: formValue(form, "gtag"), gtag_label: formValue(form, "gtag_label") }),
    );
    return "Pixel ids saved.";
  }),
);

/** The write-only CAPI access token of the page's Meta / TikTok pixel (pixel.edit: Owner only; a sealed secret). */
export const setCapiTokenAction = adminAction({ permission: "pixel.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await setCapiToken(rt.sql, rt.settings, uuid(formValue(form, "landingPageId")), parseCapiPlatform(formValue(form, "platform")), formValue(form, "value"));
    return "Access token saved.";
  }),
);

export const clearCapiTokenAction = adminAction({ permission: "pixel.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await clearCapiToken(rt.sql, uuid(formValue(form, "landingPageId")), parseCapiPlatform(formValue(form, "platform")));
    return "Access token removed.";
  }),
);

export const registerDomainAction = adminAction({ permission: "lp_domain.register" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const host = await registerDomain(rt.sql, uuid(formValue(form, "landingPageId")), formValue(form, "host"), rt.settings.domain);
    await syncLpHostsQuietly(rt.sql, rt.settings);
    return `${host} registered.`;
  }),
);

export const removeDomainAction = adminAction({ permission: "lp_domain.register" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await removeDomain(rt.sql, uuid(formValue(form, "landingPageId")), uuid(formValue(form, "domainId")));
    await syncLpHostsQuietly(rt.sql, rt.settings);
    return "Domain removed.";
  }),
);

/** Rollback (or forward): makes a kept ZIP version the live one on every domain of the page. */
export const activateLpVersionAction = adminAction({ permission: "lp_zip.publish" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const version = await activateLpVersion(rt.sql, rt.settings, uuid(formValue(form, "landingPageId")), uuid(formValue(form, "versionId")));
    return `Version ${String(version)} is live.`;
  }),
);

/** The way back to an external page: its domains stop serving the ZIP; the versions stay for later. */
export const stopLpHostingAction = adminAction({ permission: "lp_zip.publish" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await stopLpHosting(rt.sql, rt.settings, uuid(formValue(form, "landingPageId")));
    return "The page is external again: its domains no longer serve the ZIP.";
  }),
);
