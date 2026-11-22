// US-015: the Owner's alert recipients (lib/settings/alert-recipients.ts) against a real database, as the admin_rw login: validation, the
// audited save (the number and address classified as PII), the test alert the relay sends past the minimum, and what Staff and the
// public login can reach (policy and grants).
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { can, PERMISSIONS } from "../src/lib/policy.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import {
  getAlertRecipients,
  NO_ALERT_RECIPIENTS,
  parseAlertRecipients,
  saveAlertRecipients,
  sendTestAlert,
  TEST_ALERT_MESSAGE,
} from "../src/lib/settings/alert-recipients.ts";
import { asAdmin, createTestAdmin, newRuntime, root } from "./support.ts";

let rt: ReturnType<typeof newRuntime>;
let ownerId = "";
beforeAll(async () => {
  rt = newRuntime();
  ownerId = (await createTestAdmin(rt, "owner")).userId;
});
beforeEach(async () => {
  await root`DELETE FROM public.alert_recipients`;
});
afterAll(async () => {
  await root`DELETE FROM public.alert_recipients`;
});

const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);

describe("parseAlertRecipients", () => {
  it("normalises the number and the address, and lets either be empty", () => {
    expect(parseAlertRecipients(form({ phone: "0812 3456 7890", email: " Owner@Example.COM ", minSeverity: "critical" }))).toEqual({ phone: "+6281234567890", email: "owner@example.com", minSeverity: "critical" });
    expect(parseAlertRecipients(form({ phone: "", email: "", minSeverity: "warning" }))).toEqual({ phone: null, email: null, minSeverity: "warning" });
  });

  it("refuses a malformed number, address or severity with a fixed message that never echoes the input", () => {
    for (const bad of [{ phone: "12345", email: "", minSeverity: "info" }, { phone: "", email: "not an address", minSeverity: "info" }, { phone: "", email: "", minSeverity: "urgent" }]) {
      try {
        parseAlertRecipients(form(bad));
        throw new Error("expected InvalidInput");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidInput);
        expect((error as Error).message).not.toContain("12345");
        expect((error as Error).message).not.toContain("not an address");
      }
    }
  });
});

describe("saving", () => {
  it("shows the defaults before anything is saved, stores one row, and audits the change with the number and address as PII", async () => {
    expect(await getAlertRecipients(rt.sql)).toEqual(NO_ALERT_RECIPIENTS);
    await as(() => saveAlertRecipients(rt.sql, ownerId, { phone: "+6281234567890", email: "owner@example.com", minSeverity: "warning" }));
    expect(await getAlertRecipients(rt.sql)).toEqual({ phone: "+6281234567890", email: "owner@example.com", minSeverity: "warning" });
    const [audit] = await root<{ text: string; pii_refs: string[] }[]>`SELECT row_to_json(a)::text AS text, pii_refs FROM audit_log a WHERE action = 'alert_recipients.update' ORDER BY id DESC LIMIT 1`;
    expect(audit).toBeDefined();
    // The audit log never holds the number or the address in the clear.
    expect(audit?.text).not.toContain("+6281234567890");
    expect(audit?.text).not.toContain("owner@example.com");
    expect(audit?.pii_refs.length).toBeGreaterThan(0);
  });

  it("refuses a save that changes nothing, and keeps a single row", async () => {
    const next = { phone: null, email: "owner@example.com", minSeverity: "info" as const };
    await as(() => saveAlertRecipients(rt.sql, ownerId, next));
    await expect(as(() => saveAlertRecipients(rt.sql, ownerId, next))).rejects.toBeInstanceOf(InvalidInput);
    const [count] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM public.alert_recipients`;
    expect(count?.n).toBe(1);
  });

  it("is refused by the table itself for a second row, a bad number or an unknown severity", async () => {
    await root`INSERT INTO public.alert_recipients (id) VALUES (1)`;
    await expect(root`INSERT INTO public.alert_recipients (id) VALUES (2)`).rejects.toMatchObject({ code: "23514" });
    await expect(root`UPDATE public.alert_recipients SET phone = '0812'`).rejects.toMatchObject({ code: "23514" });
    await expect(root`UPDATE public.alert_recipients SET min_severity = 'urgent'`).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the test alert", () => {
  it("needs a channel, then writes an info alert the relay sends past any minimum, with no data in it", async () => {
    await expect(as(() => sendTestAlert(rt.sql, ownerId))).rejects.toBeInstanceOf(InvalidInput);
    await as(() => saveAlertRecipients(rt.sql, ownerId, { phone: null, email: "owner@example.com", minSeverity: "critical" }));
    await as(() => sendTestAlert(rt.sql, ownerId));
    const [alert] = await root<{ source: string; kind: string; severity: string; message: string; payload: unknown; notified_at: Date | null }[]>`
      SELECT source, kind, severity, message, payload, notified_at FROM public.alerts WHERE kind = 'test_alert' ORDER BY created_at DESC LIMIT 1`;
    expect(alert).toMatchObject({ source: "admin", kind: "test_alert", severity: "info", message: TEST_ALERT_MESSAGE, payload: { test: true }, notified_at: null });
    const [audit] = await root<{ changes: unknown }[]>`SELECT changes FROM audit_log WHERE action = 'alert_recipients.test' ORDER BY id DESC LIMIT 1`;
    expect(audit).toBeDefined();
  });
});

describe("who can reach it", () => {
  it("is the Owner's: Staff may not edit it, and the permission exists", () => {
    expect(PERMISSIONS).toContain("alert_recipients.edit");
    expect(can("owner", "alert_recipients.edit")).toBe(true);
    expect(can("staff", "alert_recipients.edit")).toBe(false);
  });

  it("is invisible to the public login (no grant on the table)", async () => {
    const publicSql = postgres(inject("publicDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
    try {
      await expect(publicSql`SELECT phone FROM public.alert_recipients`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await publicSql.end({ timeout: 5 });
    }
  });
});
