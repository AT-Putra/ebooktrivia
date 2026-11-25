// The Owner's Alerts page (lib/alerts/open-alerts.ts) against a real database, as the admin_rw login: the open alerts grouped by kind and
// severity (counts, unsent, first and newest, the masked newest message, the resolve cut-off), the menu count, and resolving a group up to the
// newest alert the page showed, audited, never one raised after the page was read.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { can } from "../src/lib/policy.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { loadOpenAlerts, openAlertCount, parseResolveRequest, RESOLVE_ALERTS_ACTION, resolveAlertGroup } from "../src/lib/alerts/open-alerts.ts";
import { asAdmin, auditRows, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

let rt: ReturnType<typeof newRuntime>;
let ownerId = "";
// Kinds of this file only, so alerts other test files raise never count here.
const RELAY = `test_relay_${suffix()}`;
const PROBE = `test_probe_${suffix()}`;
const KINDS = [RELAY, PROBE];

const T0 = "2026-11-20T10:00:00.000001Z";
const T1 = "2026-11-20T10:00:01.111111Z";
const T2 = "2026-11-20T10:00:02.222222Z";
const T3 = "2026-11-20T10:00:03.654321Z";
const LATE = "2026-11-20T10:00:04.000001Z";

async function raise(kind: string, severity: string, message: string, createdAt: string, extra: { notified?: boolean; resolved?: boolean } = {}): Promise<void> {
  await root`
    INSERT INTO public.alerts (source, kind, severity, message, created_at, notified_at, resolved_at)
    VALUES ('worker', ${kind}, ${severity}, ${message}, ${createdAt}::timestamptz,
            ${extra.notified === true ? root`now()` : null}, ${extra.resolved === true ? root`now()` : null})`;
}

const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const mine = async () => (await loadOpenAlerts(rt.sql)).groups.filter((g) => KINDS.includes(g.kind));

beforeAll(async () => {
  rt = newRuntime();
  ownerId = (await createTestAdmin(rt, "owner")).userId;
});
beforeEach(async () => {
  await root`DELETE FROM public.alerts WHERE kind IN ${root(KINDS)}`;
  await root`DELETE FROM public.alert_recipients`;
  // The relay group: one already resolved (left out), three open of which one was sent; the newest quotes a number and an address.
  await raise(RELAY, "warning", "an older resolved one", T0, { resolved: true });
  await raise(RELAY, "warning", "WAHA send failed (first)", T1, { notified: true });
  await raise(RELAY, "warning", "WAHA send failed (second)", T2);
  await raise(RELAY, "warning", "WAHA send to 6281234567890 failed for owner@example.com", T3);
  // The same kind at another severity is another group; an info one is listed but not counted in the menu.
  await raise(RELAY, "critical", "WAHA session is down", T2);
  await raise(PROBE, "info", "probe recovered", T1);
});
afterAll(async () => {
  await root`DELETE FROM public.alerts WHERE kind IN ${root(KINDS)}`;
  await root`DELETE FROM public.alert_recipients`;
});

describe("loadOpenAlerts", () => {
  it("groups the open alerts by kind and severity, critical first, with the newest message masked and the exact cut-off", async () => {
    const groups = await mine();
    expect(groups.map((g) => `${g.kind}:${g.severity}`)).toEqual([`${RELAY}:critical`, `${RELAY}:warning`, `${PROBE}:info`]);
    const warning = groups[1];
    expect(warning).toMatchObject({ open: 3, unsent: 2, through: T3, message: "WAHA send to [number] failed for [email]" });
    expect(warning?.firstAt.toISOString()).toBe("2026-11-20T10:00:01.111Z");
    expect(warning?.lastAt.toISOString()).toBe("2026-11-20T10:00:03.654Z");
    expect(groups[0]).toMatchObject({ open: 1, unsent: 1, through: T2 });
  });

  it("says whether the relay has anywhere to send them", async () => {
    expect((await loadOpenAlerts(rt.sql)).recipientsSet).toBe(false);
    await root`INSERT INTO public.alert_recipients (id, email) VALUES (1, 'owner@example.com')`;
    expect((await loadOpenAlerts(rt.sql)).recipientsSet).toBe(true);
  });

  it("counts only warning and critical alerts for the menu", async () => {
    const before = await openAlertCount(rt.sql);
    await raise(PROBE, "info", "another info", T2);
    expect(await openAlertCount(rt.sql)).toBe(before);
    await raise(PROBE, "warning", "a warning", T2);
    expect(await openAlertCount(rt.sql)).toBe(before + 1);
  });
});

describe("parseResolveRequest", () => {
  it("accepts the group the page rendered", () => {
    expect(parseResolveRequest(form({ kind: RELAY, severity: "warning", through: T3 }))).toEqual({ kind: RELAY, severity: "warning", through: T3 });
  });

  it("refuses a malformed kind, severity or cut-off with a fixed message that never echoes the input", () => {
    const bad = [
      { kind: "Robert'); DROP TABLE alerts;--", severity: "warning", through: T3 },
      { kind: RELAY, severity: "urgent", through: T3 },
      { kind: RELAY, severity: "warning", through: "2026-11-20T10:00:03Z" },
      { kind: RELAY, severity: "warning", through: "2026-13-45T99:00:03.654321Z" },
      { kind: RELAY, severity: "warning", through: "" },
    ];
    for (const values of bad) {
      try {
        parseResolveRequest(form(values));
        throw new Error("expected InvalidInput");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidInput);
        expect((error as Error).message).not.toContain("DROP");
        expect((error as Error).message).not.toContain("urgent");
      }
    }
  });
});

describe("resolveAlertGroup", () => {
  it("closes the group up to the newest alert the page showed, leaves a later one and the other groups open, and audits it", async () => {
    const shown = (await mine()).find((g) => g.severity === "warning");
    expect(shown?.through).toBe(T3);
    // Raised after the page was read: not the Owner's to close yet.
    await raise(RELAY, "warning", "WAHA send failed (late)", LATE);
    const resolved = await asAdmin(ownerId, () => resolveAlertGroup(rt.sql, { kind: RELAY, severity: "warning", through: T3 }));
    expect(resolved).toBe(3);

    const groups = await mine();
    expect(groups.map((g) => `${g.kind}:${g.severity}:${String(g.open)}`)).toEqual([`${RELAY}:critical:1`, `${RELAY}:warning:1`, `${PROBE}:info:1`]);
    expect(groups.find((g) => g.severity === "warning")?.through).toBe(LATE);
    // The rows stay; only resolved_at is set.
    const [rows] = await root<{ total: number; resolved: number }[]>`
      SELECT count(*)::int AS total, (count(*) FILTER (WHERE resolved_at IS NOT NULL))::int AS resolved FROM public.alerts WHERE kind = ${RELAY} AND severity = 'warning'`;
    expect(rows).toEqual({ total: 5, resolved: 4 });

    const audit = (await auditRows(null, RESOLVE_ALERTS_ACTION)).at(-1);
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: ownerId, changes: { kind: RELAY, severity: "warning", count: 3, through: T3 }, pii_refs: [] });
  });

  it("refuses a group with nothing left to close and audits nothing", async () => {
    await asAdmin(ownerId, () => resolveAlertGroup(rt.sql, { kind: PROBE, severity: "info", through: T1 }));
    const audited = (await auditRows(null, RESOLVE_ALERTS_ACTION)).length;
    await expect(asAdmin(ownerId, () => resolveAlertGroup(rt.sql, { kind: PROBE, severity: "info", through: T1 }))).rejects.toThrow(
      "Nothing to resolve: these alerts are already resolved.",
    );
    // A cut-off before the group's first alert closes nothing either.
    await expect(asAdmin(ownerId, () => resolveAlertGroup(rt.sql, { kind: RELAY, severity: "critical", through: T1 }))).rejects.toBeInstanceOf(InvalidInput);
    expect((await auditRows(null, RESOLVE_ALERTS_ACTION)).length).toBe(audited);
    expect((await mine()).find((g) => g.severity === "critical")?.open).toBe(1);
  });
});

describe("who can reach it", () => {
  it("is the Owner's only", () => {
    expect(can("owner", "alerts.view")).toBe(true);
    expect(can("owner", "alerts.resolve")).toBe(true);
    expect(can("staff", "alerts.view")).toBe(false);
    expect(can("staff", "alerts.resolve")).toBe(false);
  });
});
