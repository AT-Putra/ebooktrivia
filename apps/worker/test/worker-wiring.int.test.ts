// The worker's composition (src/worker.ts) for the ports that need a key: which consumers and sweeps each port switches on, what the
// production entry (runWorker) wires from worker.env, and the second Uptime Kuma push (the alerts backstop). worker.int.test.ts has the
// relay -> consumer -> finalize path, the conversion queue and the graceful stop; the chaos tests run the real entry as a child process.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Writable } from "node:stream";
import { CryptoError, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/env.ts";
import { INBOUND_TOPIC } from "../src/delivery/index.ts";
import type { OtpSender } from "../src/otp-send.ts";
import { onShutdown } from "../src/shutdown.ts";
import type { TestSender } from "../src/template-test-send.ts";
import { runWorker, startWorker, type WorkerPorts } from "../src/worker.ts";
import { loadWorkerConfig } from "../src/worker-config.ts";
import { first, sql, suffix, waitFor } from "./support/db.ts";
import { retireSessions } from "./support/delivery.ts";
import { captureLogger } from "./support/log.ts";
import { workerEnv } from "./support/processes.ts";
import { uniquePrefix } from "./support/valkey.ts";

// runWorker registers SIGTERM / SIGINT handlers on the real process (shutdown.ts): the test takes the stop function instead and calls it.
vi.mock("../src/shutdown.ts", () => ({ onShutdown: vi.fn() }));
// runWorker makes its own logger (stdout); the test reads what it logs.
const sink = vi.hoisted(() => ({ lines: [] as Record<string, unknown>[] }));
vi.mock("../src/log.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/log.ts")>();
  const { Writable: Collector } = await import("node:stream");
  const stream = new Collector({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString("utf8").split("\n")) if (line !== "") sink.lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  return { ...actual, createLogger: (config: Parameters<typeof actual.createLogger>[0], destination?: Writable) => actual.createLogger(config, destination ?? stream) };
});

const pushes: string[] = [];
let kuma: Server;
let kumaUrl = "";
beforeAll(async () => {
  kuma = createServer((req, res) => {
    pushes.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => kuma.listen(0, "127.0.0.1", resolve));
  kumaUrl = `http://127.0.0.1:${String((kuma.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise((resolve) => kuma.close(resolve));
  await sql`DELETE FROM heartbeats WHERE component = 'worker'`;
});
beforeEach(() => {
  sink.lines.length = 0;
  pushes.length = 0;
  vi.mocked(onShutdown).mockClear();
});

const base64 = (): string => Buffer.from(generateScopeKeyPair().privateKey).toString("base64url");
const warnings = (): string[] => sink.lines.filter((l) => l["level"] === 40).map((l) => String(l["msg"]));
const started = () => sink.lines.find((l) => l["msg"] === "worker started");
/** The stop function runWorker handed to the shutdown handler. */
const stopOf = (): (() => Promise<void>) => {
  const [stop] = vi.mocked(onShutdown).mock.calls.at(-1) ?? [];
  if (stop === undefined) throw new Error("runWorker registered no shutdown handler");
  return stop;
};
/**
 * The topics of the ports that need a key. A worker started here would consume a job another test file left on any of them (with the real password-check lookup, that
 * is a request to api.pwnedpasswords.com), so those rows are marked processed before it starts.
 */
const KEYED_TOPICS = ["admin.password_hibp_check", "magic_link.resend", "otp.send", "template.test_send"];
/** The topics runWorker adds when the delivery and payment ports are wired from worker.env too. */
const WIRED_TOPICS = [...KEYED_TOPICS, INBOUND_TOPIC, "order.paid", "payment.notification", "payment.requery"];
const retireLeftoverJobs = async (topics: readonly string[]): Promise<void> => {
  await sql`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL AND topic = ANY (${topics}::text[])`;
};
/** An outbox row of `topic` whose payload no consumer can use: each consumer drops it (processed), which proves it was wired to its queue. */
const unusableJob = async (topic: string): Promise<string> => {
  // template.test_send wants a test-send id: one that matches no row is the no-op of a test-send that is already handled.
  const payload = topic === "template.test_send" ? { test_send_id: randomUUID() } : {};
  return first(await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${topic}, ${`wiring:${suffix()}`}, ${sql.json(payload)}) RETURNING id`).id;
};
const processed = async (id: string): Promise<boolean> => first(await sql<{ done: boolean }[]>`SELECT processed_at IS NOT NULL AS done FROM outbox WHERE id = ${id}`).done;
const allProcessed = async (ids: readonly string[]): Promise<boolean> => (await Promise.all(ids.map(processed))).every(Boolean);
/** A push to the alerts monitor: its status and message as Kuma got them. */
const alertsPushes = (): { status: string | null; msg: string | null }[] =>
  pushes
    .filter((p) => p.startsWith("/api/push/alerts-token"))
    .map((p) => new URL(p, "http://kuma.invalid").searchParams)
    .map((query) => ({ status: query.get("status"), msg: query.get("msg") }));

describe("startWorker with every port that needs a key", () => {
  it("gives the port of each key-gated consumer its own queue (an unusable job of each is relayed, consumed and dropped, nothing is sent), runs the alert relay's sweep, and pushes both Kuma monitors with the alerts backstop's state", async () => {
    const sent: string[] = [];
    const testSend: TestSender = {
      email: () => {
        sent.push("test-send e-mail");
        return Promise.resolve();
      },
      whatsapp: () => {
        sent.push("test-send WhatsApp");
        return Promise.resolve();
      },
    };
    const otpSender: OtpSender = {
      send: () => {
        sent.push("otp");
        return Promise.resolve();
      },
    };
    const ports: WorkerPorts = {
      testSend: () => testSend,
      otp: { opener: { openOtp: () => "123456" }, sender: () => otpSender },
      alertRelay: { senders: () => ({ email: () => Promise.resolve(), whatsapp: () => Promise.resolve() }) },
      magicLinkResend: {
        playOrigin: "https://play.ebooktrivia.example.test",
        sender: () => ({
          send: () => {
            sent.push("magic link");
            return Promise.resolve();
          },
        }),
      },
      passwordCheck: {
        opener: { openPasswordCheck: () => "0".repeat(40) },
        lookup: () => {
          sent.push("password lookup");
          return Promise.resolve({ status: "clean" });
        },
      },
    };
    // No recipient is saved: the relay runs but sends nothing, so alerts other test files left are not marked as sent. A critical alert another
    // file left unsent would turn the backstop "down", so those are resolved: the state it pushes is then the one this test sets.
    await sql`DELETE FROM public.alert_recipients`;
    await sql`UPDATE public.alerts SET resolved_at = now() WHERE severity = 'critical' AND notified_at IS NULL AND resolved_at IS NULL`;
    await retireLeftoverJobs(KEYED_TOPICS);
    const config = loadWorkerConfig(
      workerEnv(uniquePrefix(), {
        WORKER_HEARTBEAT_INTERVAL_MS: "200",
        UPTIME_KUMA_PUSH_URL: `${kumaUrl}/api/push/heartbeat-token?status=up&msg=OK&ping=`,
        UPTIME_KUMA_ALERTS_PUSH_URL: `${kumaUrl}/api/push/alerts-token?status=up&msg=OK&ping=`,
      }),
    );
    const { log, lines } = captureLogger("debug");
    const jobs = await Promise.all(KEYED_TOPICS.map(unusableJob));
    const probeKey = `wiring-backstop-${suffix()}`;
    const running = await startWorker(config, ports, log);
    try {
      await waitFor("every job consumed", () => allProcessed(jobs), 20_000);
      await waitFor("alert relay swept", () => Promise.resolve(lines.some((l) => l["msg"] === "sweep done" && l["sweeper"] === "alert_relay")), 20_000);
      await waitFor("both monitors pushed", () => Promise.resolve(pushes.some((p) => p.startsWith("/api/push/heartbeat-token")) && alertsPushes().length > 0), 20_000);
      // No critical alert is unsent: the backstop says so.
      expect(alertsPushes()[0]).toEqual({ status: "up", msg: "OK" });
      // A critical alert that has stayed unsent for 10 minutes turns it down, naming the kind and never the message.
      await sql`
        INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload, created_at)
        VALUES ('worker', 'wiring_backstop_probe', 'critical', ${probeKey}, 'private text of the alert', '{}'::jsonb, now() - interval '10 minutes')`;
      await waitFor("backstop down", () => Promise.resolve(alertsPushes().some((p) => p.status === "down")), 20_000);
    } finally {
      await sql`UPDATE public.alerts SET resolved_at = now() WHERE dedupe_key = ${probeKey}`;
      await running.stop();
    }
    expect(alertsPushes().find((p) => p.status === "down")?.msg).toBe("1 critical alert(s) unsent for over 5 min: wiring_backstop_probe");
    expect(pushes.join("\n")).not.toContain("private");
    expect(lines.find((l) => l["msg"] === "worker started")).toMatchObject({ payments: false, deliveries: false, conversions: false });
    const topics = (lines.find((l) => l["msg"] === "worker started")?.["topics"] ?? []) as string[];
    expect([...topics].sort()).toEqual(KEYED_TOPICS);
    // The unusable jobs were dropped before any sender or lookup was asked.
    expect(sent).toEqual([]);
    expect(lines.filter((l) => l["msg"] === "magic link resend dropped").map((l) => l["reason"])).toEqual(["bad_payload"]);
    expect(lines.filter((l) => l["msg"] === "password check dropped").map((l) => l["reason"])).toEqual(["bad_payload"]);
  });
});

describe("runWorker (the production entry, in process)", () => {
  it("starts with nothing but the database and Valkey: says once for each missing key what stays off, wires no consumer, and registers the graceful stop", async () => {
    await runWorker(workerEnv(uniquePrefix()));
    try {
      expect(warnings()).toEqual(
        expect.arrayContaining([
          "SECRETS_MESSAGING_PRIVATE_KEY is not set: OTP login codes are not sent",
          "SECRETS_MESSAGING_PRIVATE_KEY is not set: alerts are not relayed to the Owner by WhatsApp and e-mail",
          "SECRETS_MESSAGING_PRIVATE_KEY or DOMAIN is not set: login links asked for again are not sent",
          "SECRETS_MESSAGING_PRIVATE_KEY is not set: admin passwords are not checked against known breaches",
          "SECRETS_PAYMENT_PRIVATE_KEY is not set: Midtrans notifications are not processed and no order can become PAID",
          "SECRETS_CONVERSIONS_PRIVATE_KEY is not set: no adnet postback and no CAPI event is sent",
          "deliveries are off: SECRETS_MESSAGING_PRIVATE_KEY is not set; no ebook is sent by WhatsApp or e-mail",
        ]),
      );
      expect(started()).toMatchObject({ topics: [], payments: false, deliveries: false, conversions: false, conversionSinks: false });
      expect(vi.mocked(onShutdown)).toHaveBeenCalledTimes(1);
    } finally {
      await stopOf()();
    }
  });

  it("refuses to start when the messaging key is set but the payment key is not (deliveries sign their download URLs with it): nothing runs, no handler is registered", async () => {
    const env = workerEnv(uniquePrefix(), { SECRETS_MESSAGING_PRIVATE_KEY: base64(), DOMAIN: "ebooktrivia.example.test" });
    await expect(runWorker(env)).rejects.toBeInstanceOf(ConfigError);
    // A key that does not parse stops the worker too, naming the variable and never the value.
    const failure: unknown = await runWorker({ ...env, SECRETS_PAYMENT_PRIVATE_KEY: base64(), SECRETS_MESSAGING_PRIVATE_KEY: "bad-key-value-0001" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CryptoError);
    expect(failure).toMatchObject({ code: "invalid_key", message: "SECRETS_MESSAGING_PRIVATE_KEY is not a base64url X25519 key" });
    expect((failure as Error).message).not.toContain("bad-key-value-0001");
    expect(started()).toBeUndefined();
    expect(vi.mocked(onShutdown)).not.toHaveBeenCalled();
  });

  it("with the keys of worker.env (and a DOMAIN) wires the test-send, OTP, login-link, password-check, alert and delivery ports from them", async () => {
    await sql`DELETE FROM public.alert_recipients`;
    await retireSessions();
    // This worker has the REAL password-check lookup (api.pwnedpasswords.com), the real senders and the delivery runtime: no job another file left may reach them.
    await retireLeftoverJobs(WIRED_TOPICS);
    const env = workerEnv(uniquePrefix(), {
      SECRETS_MESSAGING_PRIVATE_KEY: base64(),
      SECRETS_PAYMENT_PRIVATE_KEY: base64(),
      DOMAIN: "ebooktrivia.example.test",
    });
    // Midtrans stays a port of its own, with a clock that never says "02:00 WIB": the nightly reconciliation must not claim a day in the shared database.
    const payments = { midtrans: () => Promise.reject(new Error("Midtrans is not asked in this test")), waDelayMs: 0, clock: () => new Date("2030-01-01T18:00:00.000Z") };
    await runWorker(env, { payments });
    try {
      const line = started();
      expect(line).toMatchObject({ payments: true, deliveries: true, conversions: false });
      expect([...((line?.["topics"] ?? []) as string[])].sort()).toEqual(
        [INBOUND_TOPIC, "template.test_send", "payment.notification", "payment.requery", "order.paid", "otp.send", "magic_link.resend", "admin.password_hibp_check"].sort(),
      );
      // Only the conversions key is missing, so that is the one thing the worker says is off.
      expect(warnings()).toEqual(["SECRETS_CONVERSIONS_PRIVATE_KEY is not set: no adnet postback and no CAPI event is sent"]);
      // A job of each port that came from the environment reaches its consumer through the relay and BullMQ, and is dropped before a real sender or lookup is used.
      const jobs = await Promise.all(KEYED_TOPICS.map(unusableJob));
      await waitFor("every consumer dropped its unusable job", () => allProcessed(jobs), 20_000);
      expect(sink.lines.filter((l) => l["msg"] === "magic link resend dropped").map((l) => l["reason"])).toEqual(["bad_payload"]);
      expect(sink.lines.filter((l) => l["msg"] === "password check dropped").map((l) => l["reason"])).toEqual(["bad_payload"]);
    } finally {
      await stopOf()();
    }
  });
});
