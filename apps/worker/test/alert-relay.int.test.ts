// US-015: the alert relay and its backstop (src/alert-relay.ts), as worker_rw on a real database: the digest (at most 10 listed, critical
// first, "+N more", messages clipped and masked, the payload never sent), the rows marked only when a channel took the digest, the rate
// limits (one a minute, 20 an hour), one channel failing, SKIP LOCKED between two workers, the Owner's test alert past the minimum, the
// recipients' grants, and the backstop's state for Uptime Kuma.
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  type AlertSenders,
  alertsBackstop,
  buildDigest,
  CLAIM_LIMIT,
  createAlertRelay,
  MAX_DIGESTS_PER_HOUR,
  MAX_LISTED,
  MESSAGE_MAX,
  pushAlertsBackstop,
} from "../src/alert-relay.ts";
import { createLogger } from "../src/log.ts";
import { sql } from "./support/db.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});
const log = createLogger({ level: "silent", role: "worker" });

interface Sent {
  readonly channel: "email" | "whatsapp";
  readonly to: string;
  readonly text: string;
  readonly subject?: string;
}

function senders(sent: Sent[], failing: { email?: boolean; whatsapp?: boolean } = {}): AlertSenders {
  return {
    email: (message) => {
      if (failing.email === true) return Promise.reject(new Error("smtp down: to ops@example.com"));
      sent.push({ channel: "email", to: message.to, text: message.text, subject: message.subject });
      return Promise.resolve();
    },
    whatsapp: (message) => {
      if (failing.whatsapp === true) return Promise.reject(new Error("waha down"));
      sent.push({ channel: "whatsapp", to: message.to, text: message.text });
      return Promise.resolve();
    },
  };
}

const setRecipients = async (phone: string | null, email: string | null, minSeverity = "warning"): Promise<void> => {
  await sql`DELETE FROM public.alert_recipients`;
  await sql`INSERT INTO public.alert_recipients (id, phone, email, min_severity) VALUES (1, ${phone}, ${email}, ${minSeverity})`;
};
let n = 0;
const addAlert = async (severity: string, message: string, extra: { kind?: string; payload?: object; source?: string; minutesAgo?: number } = {}): Promise<string> => {
  n++;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload, created_at)
    VALUES (${extra.source ?? "worker"}, ${extra.kind ?? `kind_${String(n)}`}, ${severity}, ${`relay-test-${String(n)}-${Math.random().toString(36).slice(2)}`}, ${message},
            ${JSON.stringify(extra.payload ?? {})}::text::jsonb, now() - make_interval(mins => ${extra.minutesAgo ?? 0}))
    RETURNING id`;
  return row?.id ?? "";
};
const notified = async (id: string): Promise<boolean> => (await sql<{ notified_at: Date | null }[]>`SELECT notified_at FROM public.alerts WHERE id = ${id}`)[0]?.notified_at !== null;

beforeEach(async () => {
  await sql`DELETE FROM public.alerts`;
  await sql`DELETE FROM public.alert_recipients`;
});

describe("buildDigest", () => {
  it("lists at most 10 alerts, the critical ones first, clips each message to 300 characters and counts the rest", () => {
    const alerts = [
      ...Array.from({ length: 8 }, (_, i) => ({ kind: `w${String(i)}`, severity: "warning" as const, message: "x".repeat(900) })),
      ...Array.from({ length: 5 }, (_, i) => ({ kind: `c${String(i)}`, severity: "critical" as const, message: `critical ${String(i)}` })),
    ];
    const digest = buildDigest(alerts);
    const lines = digest.text.trimEnd().split("\n");
    expect(lines).toHaveLength(MAX_LISTED + 1);
    expect(lines.slice(0, 5).every((l) => l.startsWith("[critical] c"))).toBe(true);
    expect(lines[5]).toMatch(/^\[warning\] w0: x+$/);
    expect(lines[5]?.length).toBeLessThanOrEqual("[warning] w0: ".length + MESSAGE_MAX);
    expect(lines[MAX_LISTED]).toBe("+3 more");
    expect(digest.subject).toMatch(/^\[critical\] 13 alerts: c0, c1, c2, \.\.\.$/);
  });

  it("masks e-mail addresses and phone-like numbers and drops control characters, whatever the code wrote", () => {
    const digest = buildDigest([{ kind: "odd_kind", severity: "warning", message: "buyer budi@example.com +62 812-3456-7890 \u0000 paid\u0007" }]);
    expect(digest.text).toBe("[warning] odd_kind: buyer [email] [number] paid\n");
  });
});

describe("the relay", () => {
  it("sends nothing and marks nothing while no recipient is set", async () => {
    const sent: Sent[] = [];
    const id = await addAlert("critical", "no recipients");
    const relay = createAlertRelay({ sql: workerSql, log, senders: senders(sent) });
    expect((await relay.sweep()).outcome).toBe("no_recipients");
    await setRecipients(null, null);
    expect((await relay.sweep()).outcome).toBe("no_recipients");
    expect(sent).toEqual([]);
    expect(await notified(id)).toBe(false);
  });

  it("builds one digest of the alerts at or above the minimum, sends it by e-mail and WhatsApp, and marks exactly the rows it covered", async () => {
    await setRecipients("+6281234567890", "owner@example.com", "warning");
    const sent: Sent[] = [];
    const critical = await Promise.all(Array.from({ length: 3 }, (_, i) => addAlert("critical", `critical thing ${String(i)}`, { kind: `crit_${String(i)}` })));
    const warnings = await Promise.all(Array.from({ length: 9 }, (_, i) => addAlert("warning", `warning thing ${String(i)}`)));
    const infos = await Promise.all(Array.from({ length: 2 }, () => addAlert("info", "just so you know")));
    const relay = createAlertRelay({ sql: workerSql, log, senders: senders(sent) });
    const result = await relay.sweep();
    expect(result).toMatchObject({ outcome: "sent", included: 12, email: "sent", whatsapp: "sent" });
    expect(sent.map((s) => s.channel).sort()).toEqual(["email", "whatsapp"]);
    const email = sent.find((s) => s.channel === "email");
    const wa = sent.find((s) => s.channel === "whatsapp");
    expect(email?.to).toBe("owner@example.com");
    expect(wa?.to).toBe("+6281234567890");
    const lines = (email?.text ?? "").trimEnd().split("\n");
    expect(lines).toHaveLength(MAX_LISTED + 1);
    expect(lines.slice(0, 3).every((l) => l.startsWith("[critical] crit_"))).toBe(true);
    expect(lines[MAX_LISTED]).toBe("+2 more");
    expect(wa?.text).toContain("+2 more");
    for (const id of [...critical, ...warnings]) expect(await notified(id), id).toBe(true);
    for (const id of infos) expect(await notified(id), id).toBe(false);
    // Nothing new: the next sweep (past the rate limit) sends nothing.
    expect((await createAlertRelay({ sql: workerSql, log, senders: senders(sent) }).sweep()).outcome).toBe("idle");
  });

  it("claims at most CLAIM_LIMIT rows a digest and leaves the rest for the next one", async () => {
    await setRecipients(null, "owner@example.com", "info");
    const ids: string[] = [];
    for (let i = 0; i < CLAIM_LIMIT + 5; i++) ids.push(await addAlert("warning", "many"));
    const sent: Sent[] = [];
    expect((await createAlertRelay({ sql: workerSql, log, senders: senders(sent) }).sweep()).included).toBe(CLAIM_LIMIT);
    const left = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.alerts WHERE notified_at IS NULL`;
    expect(left[0]?.n).toBe(5);
  });

  it("never sends the payload or anything of a message that looks like personal data", async () => {
    await setRecipients("+6281234567890", "owner@example.com", "info");
    await addAlert("warning", "reconciliation: order for buyer@example.com or +62 813 9999 8888", { payload: { phone: "+6285511122233", email: "secret@example.org", note: "PAYLOAD-ONLY-TEXT" } });
    const sent: Sent[] = [];
    await createAlertRelay({ sql: workerSql, log, senders: senders(sent) }).sweep();
    const all = sent.map((s) => `${s.subject ?? ""}\n${s.text}`).join("\n");
    expect(all).toContain("[email]");
    expect(all).toContain("[number]");
    for (const secret of ["buyer@example.com", "813 9999 8888", "+6285511122233", "secret@example.org", "PAYLOAD-ONLY-TEXT"]) expect(all).not.toContain(secret);
  });

  it("sends at most one digest a minute, and a limited sweep changes nothing", async () => {
    await setRecipients(null, "owner@example.com", "info");
    const sent: Sent[] = [];
    let clock = Date.parse("2026-11-22T10:00:00Z");
    const relay = createAlertRelay({ sql: workerSql, log, senders: senders(sent), now: () => clock });
    const first = await addAlert("warning", "first");
    expect((await relay.sweep()).outcome).toBe("sent");
    const second = await addAlert("critical", "second");
    clock += 30_000;
    expect((await relay.sweep()).outcome).toBe("rate_limited");
    expect(await notified(second)).toBe(false);
    clock += 31_000;
    expect((await relay.sweep()).outcome).toBe("sent");
    expect(await notified(second)).toBe(true);
    expect(await notified(first)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("sends at most 20 digests an hour, and the next hour sends what waited", async () => {
    await setRecipients(null, "owner@example.com", "info");
    const sent: Sent[] = [];
    let clock = Date.parse("2026-11-22T10:00:00Z");
    const relay = createAlertRelay({ sql: workerSql, log, senders: senders(sent), now: () => clock });
    for (let i = 0; i < MAX_DIGESTS_PER_HOUR; i++) {
      await addAlert("warning", `digest ${String(i)}`);
      expect((await relay.sweep()).outcome, `digest ${String(i + 1)}`).toBe("sent");
      clock += 61_000;
    }
    const blocked = await addAlert("critical", "over the hourly cap");
    expect((await relay.sweep()).outcome).toBe("rate_limited");
    expect(await notified(blocked)).toBe(false);
    clock += 3_600_000;
    expect((await relay.sweep()).outcome).toBe("sent");
    expect(await notified(blocked)).toBe(true);
    expect(sent).toHaveLength(MAX_DIGESTS_PER_HOUR + 1);
  });

  it("marks the rows when one channel took the digest, and leaves them for a retry only when both failed", async () => {
    await setRecipients("+6281234567890", "owner@example.com", "info");
    let clock = Date.parse("2026-11-22T10:00:00Z");
    // E-mail down, WhatsApp up: the Owner has it, the rows are marked (a second message a minute would be noise), the failure is reported.
    const a = await addAlert("critical", "one channel");
    const sentA: Sent[] = [];
    const half = await createAlertRelay({ sql: workerSql, log, senders: senders(sentA, { email: true }), now: () => clock }).sweep();
    expect(half).toMatchObject({ outcome: "sent", email: "failed", whatsapp: "sent" });
    expect(sentA.map((s) => s.channel)).toEqual(["whatsapp"]);
    expect(await notified(a)).toBe(true);
    // Both down: rolled back, retried on the next sweep that is allowed.
    const b = await addAlert("critical", "both channels");
    const sentB: Sent[] = [];
    const relay = createAlertRelay({ sql: workerSql, log, senders: senders(sentB, { email: true, whatsapp: true }), now: () => clock });
    clock += 61_000;
    expect(await relay.sweep()).toMatchObject({ outcome: "failed", email: "failed", whatsapp: "failed" });
    expect(await notified(b)).toBe(false);
    const recovered = createAlertRelay({ sql: workerSql, log, senders: senders(sentB), now: () => clock });
    clock += 61_000;
    expect((await recovered.sweep()).outcome).toBe("sent");
    expect(await notified(b)).toBe(true);
  });

  it("does not send an alert that was resolved before the relay saw it", async () => {
    await setRecipients(null, "owner@example.com", "info");
    const id = await addAlert("critical", "already handled");
    await sql`UPDATE public.alerts SET resolved_at = now() WHERE id = ${id}`;
    const sent: Sent[] = [];
    expect((await createAlertRelay({ sql: workerSql, log, senders: senders(sent) }).sweep()).outcome).toBe("idle");
    expect(sent).toEqual([]);
  });

  it("sends the Owner's test alert whatever the lowest severity is, and only that one below it", async () => {
    await setRecipients(null, "owner@example.com", "critical");
    const info = await addAlert("info", "an ordinary info alert");
    const test = await addAlert("info", "Test alert from the admin console", { kind: "test_alert", source: "admin", payload: { test: true } });
    const sent: Sent[] = [];
    expect((await createAlertRelay({ sql: workerSql, log, senders: senders(sent) }).sweep()).included).toBe(1);
    expect(sent[0]?.text).toContain("test_alert");
    expect(await notified(test)).toBe(true);
    expect(await notified(info)).toBe(false);
  });

  it("lets only one of two workers send a row: the other skips what the first has locked", async () => {
    await setRecipients(null, "owner@example.com", "info");
    const id = await addAlert("critical", "contended");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sentSlow: Sent[] = [];
    const slow: AlertSenders = {
      email: async (message) => {
        await gate;
        sentSlow.push({ channel: "email", to: message.to, text: message.text });
      },
      whatsapp: () => Promise.resolve(),
    };
    const sentFast: Sent[] = [];
    const first = createAlertRelay({ sql: workerSql, log, senders: slow }).sweep();
    // The first worker's transaction holds the row while its e-mail waits; a second worker finds nothing it may claim.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await createAlertRelay({ sql: workerSql, log, senders: senders(sentFast) }).sweep()).outcome).toBe("idle");
    release();
    expect((await first).outcome).toBe("sent");
    expect(sentFast).toEqual([]);
    expect(sentSlow).toHaveLength(1);
    expect(await notified(id)).toBe(true);
  });

  it("gives worker_rw the recipients to read and nothing to change; the public login sees none of it", async () => {
    await setRecipients("+6281234567890", "owner@example.com");
    const [row] = await workerSql<{ phone: string }[]>`SELECT phone FROM public.alert_recipients WHERE id = 1`;
    expect(row?.phone).toBe("+6281234567890");
    await expect(workerSql`UPDATE public.alert_recipients SET phone = '+6281111111111'`).rejects.toMatchObject({ code: "42501" });
    const publicSql = postgres(inject("publicDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
    try {
      await expect(publicSql`SELECT phone FROM public.alert_recipients`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await publicSql.end({ timeout: 5 });
    }
  });
});

describe("the backstop", () => {
  it("is DOWN while a critical alert has stayed unsent for more than 5 minutes, naming kinds and never messages, and UP otherwise", async () => {
    expect(await alertsBackstop(workerSql)).toEqual({ status: "up", msg: "OK" });
    const fresh = await addAlert("critical", "just now", { kind: "fresh_one", minutesAgo: 2 });
    await addAlert("warning", "old but only a warning", { kind: "only_warning", minutesAgo: 90 });
    expect((await alertsBackstop(workerSql)).status).toBe("up");
    const stale = await addAlert("critical", "reversed payment for buyer@example.com", { kind: "payment_paid_reversed", minutesAgo: 6 });
    const down = await alertsBackstop(workerSql);
    expect(down.status).toBe("down");
    expect(down.msg).toContain("1 critical alert(s) unsent for over 5 min: payment_paid_reversed");
    expect(down.msg).not.toContain("buyer");
    expect(down.msg).not.toContain("fresh_one");
    // Sent, or resolved: UP again.
    await sql`UPDATE public.alerts SET notified_at = now() WHERE id = ${stale}`;
    expect((await alertsBackstop(workerSql)).status).toBe("up");
    await sql`UPDATE public.alerts SET notified_at = NULL, resolved_at = now() WHERE id = ${stale}`;
    expect((await alertsBackstop(workerSql)).status).toBe("up");
    expect(fresh).not.toBe("");
  });

  it("pushes the state to Kuma as status and msg on its push URL, and never throws when Kuma is down", async () => {
    await addAlert("critical", "stuck", { kind: "relay_is_broken", minutesAgo: 10 });
    const urls: string[] = [];
    const push = {
      fetch: ((url: URL) => {
        urls.push(url.href);
        return Promise.resolve({ status: 200, cancel: () => Promise.resolve() });
      }) as never,
      url: new URL("https://kuma.example.com/api/push/token123?ping="),
    };
    expect(await pushAlertsBackstop({ sql: workerSql, push, log })).toBe(true);
    const sent = new URL(urls[0] ?? "");
    expect(sent.origin + sent.pathname).toBe("https://kuma.example.com/api/push/token123");
    expect(sent.searchParams.get("status")).toBe("down");
    expect(sent.searchParams.get("msg")).toContain("relay_is_broken");
    const refused = { ...push, fetch: (() => Promise.resolve({ status: 404, cancel: () => Promise.resolve() })) as never };
    expect(await pushAlertsBackstop({ sql: workerSql, push: refused, log })).toBe(false);
    const broken = { ...push, fetch: (() => Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }))) as never };
    expect(await pushAlertsBackstop({ sql: workerSql, push: broken, log })).toBe(false);
  });
});
