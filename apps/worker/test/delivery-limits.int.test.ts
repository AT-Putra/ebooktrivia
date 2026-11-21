// US-025: what WhatsApp tells us about a number's limits (WAHA GET /sessions/{session}/timelock and /capping, the shapes verified live in the US-005 audit):
// the number's state is persisted, a held-back number sends no new-contact message until the end WAHA names, a warning slows it, and the Owner is alerted
// (persisted, with how often WhatsApp refused it). Read every few minutes for a WORKING number and at once after a 463 / 475; best effort throughout.
import { DELIVERY_GAP_MS, REACHOUT_COOLDOWN_MS } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSessionPoller, LIMITS_EVERY_MS, refreshSessionLimits } from "../src/delivery/health.ts";
import { claimSession } from "../src/delivery/pool.ts";
import type { WahaAccess } from "../src/delivery/ports.ts";
import { createSession, createWahaFake, retireSessions } from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(4);
beforeEach(retireSessions);
afterAll(retireSessions);

const waha = createWahaFake();
const refresh = (id: string, now?: () => number) => refreshSessionLimits({ sql: workerSql, log: silentLog, waha: waha.access, ...(now === undefined ? {} : { now }) }, id);
const stateOf = async (id: string) =>
  first(
    await sql<{ timelock_active: boolean | null; timelock_ends_at: Date | null; capping_status: string | null; warning_level: string; reachout_until: Date | null; limits_checked_at: Date | null }[]>`
      SELECT timelock_active, timelock_ends_at, capping_status, warning_level, reachout_until, limits_checked_at FROM waha_sessions WHERE id = ${id}`,
  );
const alertsOf = (id: string) => sql<{ severity: string; dedupe_key: string; payload: Record<string, unknown> }[]>`SELECT severity, dedupe_key, payload FROM alerts WHERE dedupe_key LIKE ${`waha_limits:${id}:%`} AND resolved_at IS NULL`;
const inSeconds = (s: number): number => Math.floor(Date.now() / 1000) + s;
const near = (date: Date | null, unixSeconds: number): boolean => date !== null && Math.abs(date.getTime() - unixSeconds * 1000) < 2000;

describe("WhatsApp's timelock and message capping on a number", () => {
  it("an active reachout timelock holds the number back from new contacts until its end, persists the state, and alerts critically with the counts of refusals", async () => {
    const s = await createSession();
    await sql`UPDATE waha_sessions SET ban_463_count = 2, ban_475_count = 1 WHERE id = ${s.id}`;
    const end = inSeconds(7200);
    await waha.limits(s.name, { timelock: { isActive: true, timeEnforcementEnds: end } });
    expect(await refresh(s.id)).toBe(true);
    const state = await stateOf(s.id);
    expect(state.timelock_active).toBe(true);
    expect(near(state.timelock_ends_at, end)).toBe(true);
    expect(near(state.reachout_until, end)).toBe(true);
    expect(state.limits_checked_at).not.toBeNull();
    const [alert, ...others] = await alertsOf(s.id);
    expect(others).toEqual([]);
    expect(alert?.severity).toBe("critical");
    expect(alert?.dedupe_key).toBe(`waha_limits:${s.id}:held`);
    expect(alert?.payload).toMatchObject({ session_id: s.id, timelock_active: true, refused_463: 2, refused_475: 1 });
    // No new-contact message goes out of it; an alert for the whole pool follows from the delivery that finds every number held back.
    expect(await workerSql.begin((tx) => claimSession(tx, { exclude: [], kind: "opener", deliveryId: null, gap: DELIVERY_GAP_MS, random: () => 0, newContact: true }))).toMatchObject({ kind: "none", reason: "all_reachout_blocked" });
  });

  it("a timelock without an end holds it back for the cooldown (an hour), and never moves an end that is already further away", async () => {
    const s = await createSession();
    await waha.limits(s.name, { timelock: { isActive: true } });
    await refresh(s.id);
    const first_ = (await stateOf(s.id)).reachout_until;
    expect(Math.abs((first_?.getTime() ?? 0) - (Date.now() + REACHOUT_COOLDOWN_MS))).toBeLessThan(60_000);
    const far = new Date(Date.now() + 5 * REACHOUT_COOLDOWN_MS);
    await sql`UPDATE waha_sessions SET reachout_until = ${far} WHERE id = ${s.id}`;
    await refresh(s.id);
    expect((await stateOf(s.id)).reachout_until?.getTime()).toBe(far.getTime());
  });

  it("FIRST_WARNING and SECOND_WARNING shrink the number's new-contact share and alert (a warning, not a hold); NONE brings it back", async () => {
    const s = await createSession();
    await waha.limits(s.name, { capping: { cappingStatus: "FIRST_WARNING" } });
    await refresh(s.id);
    expect(await stateOf(s.id)).toMatchObject({ warning_level: "first", capping_status: "FIRST_WARNING", reachout_until: null });
    await waha.limits(s.name, { capping: { cappingStatus: "SECOND_WARNING" } });
    await refresh(s.id);
    expect(await stateOf(s.id)).toMatchObject({ warning_level: "second", reachout_until: null });
    const alerts = await alertsOf(s.id);
    expect(alerts.map((a) => [a.dedupe_key, a.severity]).sort()).toEqual([[`waha_limits:${s.id}:first`, "warning"], [`waha_limits:${s.id}:second`, "warning"]]);
    await waha.limits(s.name, { capping: { cappingStatus: "NONE" } });
    await refresh(s.id);
    expect(await stateOf(s.id)).toMatchObject({ warning_level: "none", capping_status: "NONE" });
    expect(await alertsOf(s.id)).toHaveLength(2);
  });

  it("CAPPED holds the number back until the end of the capping cycle", async () => {
    const s = await createSession();
    const end = inSeconds(86_400);
    await waha.limits(s.name, { capping: { cappingStatus: "CAPPED", cycleEnd: end } });
    await refresh(s.id);
    expect(near((await stateOf(s.id)).reachout_until, end)).toBe(true);
    expect((await alertsOf(s.id)).map((a) => [a.dedupe_key, a.severity])).toEqual([[`waha_limits:${s.id}:held`, "critical"]]);
  });

  it("a quiet number (no timelock, no capping) is recorded as such and raises nothing", async () => {
    const s = await createSession();
    await refresh(s.id);
    expect(await stateOf(s.id)).toMatchObject({ timelock_active: false, capping_status: "NONE", warning_level: "none", reachout_until: null });
    expect(await alertsOf(s.id)).toEqual([]);
  });

  it("asks again at the next poll when WAHA cannot say: an instance without the endpoints, one that fails, or one that is down leaves the state as it was", async () => {
    const s = await createSession();
    await waha.limits(s.name, { capping: { cappingStatus: "SECOND_WARNING" } });
    await refresh(s.id);
    // An instance that has neither endpoint (a 404 on both): nothing is learned, nothing changes.
    const none: WahaAccess = {
      withSession: (id, use, options) =>
        waha.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, reachoutTimelock: () => Promise.resolve(null), messageCapping: () => Promise.resolve(null) } }), options),
    };
    expect(await refreshSessionLimits({ sql: workerSql, log: silentLog, waha: none }, s.id)).toBe(false);
    // Both calls fail (a 5xx): the same.
    const failing: WahaAccess = {
      withSession: (id, use, options) =>
        waha.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, reachoutTimelock: () => Promise.reject(new Error("x")), messageCapping: () => Promise.reject(new Error("x")) } }), options),
    };
    expect(await refreshSessionLimits({ sql: workerSql, log: silentLog, waha: failing }, s.id)).toBe(false);
    // Only the timelock fails: the capping answer is still taken.
    const half: WahaAccess = {
      withSession: (id, use, options) => waha.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, reachoutTimelock: () => Promise.reject(new Error("x")) } }), options),
    };
    expect(await refreshSessionLimits({ sql: workerSql, log: silentLog, waha: half }, s.id)).toBe(true);
    expect(await stateOf(s.id)).toMatchObject({ warning_level: "second", capping_status: "SECOND_WARNING" });
    // The WAHA box is down.
    waha.outage(s.name, true);
    try {
      expect(await refresh(s.id)).toBe(false);
    } finally {
      waha.outage(s.name, false);
    }
    expect(await refresh(s.id, () => 1)).toBe(true);
  });
});

describe("when only one of the two calls answers, or the number cannot be opened", () => {
  it("only the capping call fails: the timelock answer is taken and the warning level stays as it was", async () => {
    const s = await createSession();
    await sql`UPDATE waha_sessions SET warning_level = 'first' WHERE id = ${s.id}`;
    const end = inSeconds(3600);
    await waha.limits(s.name, { timelock: { isActive: true, timeEnforcementEnds: end } });
    const noCapping: WahaAccess = {
      withSession: (id, use, options) =>
        waha.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, messageCapping: () => Promise.reject(new Error("x")) } }), options),
    };
    expect(await refreshSessionLimits({ sql: workerSql, log: silentLog, waha: noCapping }, s.id)).toBe(true);
    const state = await stateOf(s.id);
    expect(state).toMatchObject({ timelock_active: true, warning_level: "first", capping_status: null });
    expect(near(state.reachout_until, end)).toBe(true);
    expect((await alertsOf(s.id)).map((a) => a.dedupe_key)).toEqual([`waha_limits:${s.id}:held`]);
  });

  it("a number that cannot be opened (an unknown or switched-off session) is not read", async () => {
    const s = await createSession();
    await sql`UPDATE waha_sessions SET active = false WHERE id = ${s.id}`;
    expect(await refresh(s.id)).toBe(false);
    expect(await refresh("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect((await stateOf(s.id)).limits_checked_at).toBeNull();
  });
});

describe("the poll reads the limits of a WORKING number every few minutes, not at every poll", () => {
  const timelockCalls = (name: string): number => waha.calls.filter((c) => c.session === name && c.path.endsWith("/timelock")).length;

  it("reads them at the first poll, not again within the interval, again after it, and never for a number that is not WORKING", async () => {
    const working = await createSession({ status: null });
    const away = await createSession({ status: null });
    await waha.status(away.name, "SCAN_QR_CODE");
    let wall = 1_000_000_000;
    const poll = createSessionPoller({ sql: workerSql, log: silentLog, waha: waha.access, now: () => wall });
    const before = timelockCalls(working.name);
    await poll();
    expect(timelockCalls(working.name) - before).toBe(1);
    expect((await stateOf(working.id)).limits_checked_at).not.toBeNull();
    wall += 60_000;
    await poll();
    expect(timelockCalls(working.name) - before).toBe(1);
    wall += LIMITS_EVERY_MS;
    await poll();
    expect(timelockCalls(working.name) - before).toBe(2);
    expect(timelockCalls(away.name)).toBe(0);
    expect((await stateOf(away.id)).limits_checked_at).toBeNull();
  });

  it("a number whose limits cannot be recorded does not stop the poll (the status is still written)", async () => {
    const s = await createSession({ status: null });
    const broken: WahaAccess = {
      withSession: (id, use, options) =>
        waha.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, reachoutTimelock: () => Promise.reject(new Error("x")), messageCapping: () => Promise.reject(new Error("x")) } }), options),
    };
    const poll = createSessionPoller({ sql: workerSql, log: silentLog, waha: broken });
    expect(await poll()).toEqual({ total: 1, working: 1 });
    expect(first(await sql<{ status: string }[]>`SELECT status FROM waha_sessions WHERE id = ${s.id}`).status).toBe("WORKING");
  });
});
