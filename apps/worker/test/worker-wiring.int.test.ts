// The worker's composition (src/worker.ts) for the ports that need a key: which consumers and sweeps each port switches on, what the
// production entry (runWorker) wires from worker.env, and the second Uptime Kuma push (the alerts backstop). worker.int.test.ts has the
// relay -> consumer -> finalize path, the conversion queue and the graceful stop; the chaos tests run the real entry as a child process.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Writable } from "node:stream";
import { generateScopeKeyPair } from "@ebooktrivia/crypto";
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
/** An outbox row of `topic` whose payload no consumer can use: each consumer drops it (processed), which proves it was wired to its queue. */
const unusableJob = async (topic: string): Promise<string> =>
  first(await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${topic}, ${`wiring:${suffix()}`}, '{}'::jsonb) RETURNING id`).id;
const processed = async (id: string): Promise<boolean> => first(await sql<{ done: boolean }[]>`SELECT processed_at IS NOT NULL AS done FROM outbox WHERE id = ${id}`).done;

describe("startWorker with every port that needs a key", () => {
  it("relays and runs the jobs of each port's consumer, runs the alert relay and the delivery-free sweeps, and pushes both Kuma monitors", async () => {
    const testSend: TestSender = { email: () => Promise.resolve(), whatsapp: () => Promise.resolve() };
    const otpSender: OtpSender = { send: () => Promise.resolve() };
    const ports: WorkerPorts = {
      testSend: () => testSend,
      otp: { opener: { openOtp: () => "123456" }, sender: () => otpSender },
      alertRelay: { senders: () => ({ email: () => Promise.resolve(), whatsapp: () => Promise.resolve() }) },
      magicLinkResend: { playOrigin: "https://play.ebooktrivia.example.test", sender: () => ({ send: () => Promise.resolve() }) },
      passwordCheck: { opener: { openPasswordCheck: () => "0".repeat(40) }, lookup: () => Promise.resolve({ status: "clean" }) },
    };
    // No recipient is saved: the relay runs but sends nothing, so alerts other test files left are not marked as sent.
    await sql`DELETE FROM public.alert_recipients`;
    const config = loadWorkerConfig(
      workerEnv(uniquePrefix(), {
        WORKER_HEARTBEAT_INTERVAL_MS: "200",
        UPTIME_KUMA_PUSH_URL: `${kumaUrl}/api/push/heartbeat-token?status=up&msg=OK&ping=`,
        UPTIME_KUMA_ALERTS_PUSH_URL: `${kumaUrl}/api/push/alerts-token?status=up&msg=OK&ping=`,
      }),
    );
    const { log, lines } = captureLogger("debug");
    const magicLinkJob = await unusableJob("magic_link.resend");
    const passwordJob = await unusableJob("admin.password_hibp_check");
    const running = await startWorker(config, ports, log);
    try {
      await waitFor("both jobs consumed", async () => (await processed(magicLinkJob)) && (await processed(passwordJob)), 20_000);
      await waitFor("alert relay swept", () => Promise.resolve(lines.some((l) => l["msg"] === "sweep done" && l["sweeper"] === "alert_relay")), 20_000);
      await waitFor("both monitors pushed", () => Promise.resolve(pushes.some((p) => p.startsWith("/api/push/heartbeat-token")) && pushes.some((p) => p.startsWith("/api/push/alerts-token"))), 20_000);
    } finally {
      await running.stop();
    }
    expect(lines.find((l) => l["msg"] === "worker started")).toMatchObject({ payments: false, deliveries: false, conversions: false });
    const topics = (lines.find((l) => l["msg"] === "worker started")?.["topics"] ?? []) as string[];
    expect([...topics].sort()).toEqual(["admin.password_hibp_check", "magic_link.resend", "otp.send", "template.test_send"]);
    // The alerts backstop says which state it is in (up while no critical alert has stayed unsent) and never what the alerts say.
    const alertsPush = pushes.find((p) => p.startsWith("/api/push/alerts-token"));
    expect(new URL(alertsPush ?? "", kumaUrl).searchParams.get("status")).toMatch(/^(up|down)$/);
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
    await expect(runWorker({ ...env, SECRETS_PAYMENT_PRIVATE_KEY: base64(), SECRETS_MESSAGING_PRIVATE_KEY: "not-a-key" })).rejects.toThrow();
    expect(started()).toBeUndefined();
    expect(vi.mocked(onShutdown)).not.toHaveBeenCalled();
  });

  it("with the keys of worker.env (and a DOMAIN) wires the test-send, OTP, login-link, password-check, alert and delivery ports from them", async () => {
    await sql`DELETE FROM public.alert_recipients`;
    await retireSessions();
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
      // A job of a port that came from the environment reaches its consumer through the relay and BullMQ.
      const job = await unusableJob("magic_link.resend");
      await waitFor("the login-link consumer dropped the unusable job", () => processed(job), 20_000);
      expect(sink.lines.some((l) => l["msg"] === "magic link resend dropped" && l["reason"] === "bad_payload")).toBe(true);
    } finally {
      await stopOf()();
    }
  });
});
