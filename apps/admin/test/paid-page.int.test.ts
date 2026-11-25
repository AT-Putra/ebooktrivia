// The page after a successful payment (2026-11-25): its three texts, one wording for every program, saved by the console in app_settings
// (order_page.paid_wording), audited, and read back with the defaults for anything missing or broken (core paid-page.ts).
import { PAID_PAGE_DEFAULTS, PAID_PAGE_SETTING_KEY } from "@ebooktrivia/core";
import { afterAll, describe, expect, it } from "vitest";
import { getPaidPageWording, parsePaidPageForm, savePaidPageWording } from "../src/lib/settings/paid-page.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { asAdmin, createTestAdmin, newRuntime, root } from "./support.ts";

const rt = newRuntime();
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

afterAll(async () => {
  await root`DELETE FROM app_settings WHERE key = ${PAID_PAGE_SETTING_KEY}`;
});

describe("the page after payment (Message templates)", () => {
  it("shows the defaults until a wording is saved; a save is audited, the same texts again change nothing, and a reset brings the defaults back", async () => {
    await root`DELETE FROM app_settings WHERE key = ${PAID_PAGE_SETTING_KEY}`;
    const owner = await createTestAdmin(rt, "owner");
    expect(await getPaidPageWording(rt.sql)).toEqual(PAID_PAGE_DEFAULTS);

    const next = parsePaidPageForm(form({ body: "  Satu langkah lagi: chat kami di WhatsApp ya.  ", button: "Chat WhatsApp sekarang", note: "" }));
    expect(next).toEqual({ body: "Satu langkah lagi: chat kami di WhatsApp ya.", button: "Chat WhatsApp sekarang", note: "" });
    await asAdmin(owner.userId, () => savePaidPageWording(rt.sql, owner.userId, next));
    expect(await getPaidPageWording(rt.sql)).toEqual(next);
    const [audit] = await root<{ action: string; entity_id: string }[]>`
      SELECT action, entity_id FROM audit_log WHERE entity_type = 'app_setting' AND entity_id = ${PAID_PAGE_SETTING_KEY} ORDER BY occurred_at DESC LIMIT 1`;
    expect(audit).toEqual({ action: "app_setting.update", entity_id: PAID_PAGE_SETTING_KEY });

    await expect(asAdmin(owner.userId, () => savePaidPageWording(rt.sql, owner.userId, next))).rejects.toThrow("Nothing changed.");
    await asAdmin(owner.userId, () => savePaidPageWording(rt.sql, owner.userId, parsePaidPageForm(form({ reset: "1" }))));
    expect(await getPaidPageWording(rt.sql)).toEqual(PAID_PAGE_DEFAULTS);
  });

  it("refuses a text that breaks a rule, with a fixed message that does not echo the input", () => {
    for (const fields of [
      { body: "Pendek", button: "Chat WhatsApp", note: "" },
      { body: "Chat kami di WhatsApp sekarang ya.", button: "x".repeat(61), note: "" },
      { body: "Chat kami\\ndi WhatsApp sekarang ya.".replace("\\n", "\n"), button: "Chat WhatsApp", note: "" },
      { body: "Chat kami di WhatsApp sekarang ya.", button: "Chat​WhatsApp", note: "" },
    ]) {
      expect(() => parsePaidPageForm(form(fields)), JSON.stringify(fields)).toThrow(InvalidInput);
    }
  });

  it("reads a stored value that breaks a rule as the defaults (the page never shows a broken text)", async () => {
    await root`
      INSERT INTO app_settings (key, value) VALUES (${PAID_PAGE_SETTING_KEY}, ${root.json({ body: "x", button: "Chat WhatsApp sekarang", note: 7 })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    expect(await getPaidPageWording(rt.sql)).toEqual({ body: PAID_PAGE_DEFAULTS.body, button: "Chat WhatsApp sekarang", note: PAID_PAGE_DEFAULTS.note });
  });
});
