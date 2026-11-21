// The human-like sequence of every WhatsApp send (US-025, Owner requirement; human.ts): the order of the calls, the pauses (random, bounded, never
// equal for consecutive recipients), best-effort presence calls that never touch the send, and no send at all when the job is aborted during a wait.
import { WahaError, type WahaClient } from "@ebooktrivia/adapters";
import { HUMAN_TIMING } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { cryptoRandom, type HumanSend, sendLikeAHuman } from "./human.ts";

interface Recorded {
  readonly calls: string[];
  readonly waits: number[];
}

/** A WAHA client that records the order of the calls (never a text), with optional failures by call name. */
function fakeClient(recorded: Recorded, failing: ReadonlySet<string> = new Set()): WahaClient {
  const call = (name: string): Promise<void> => {
    recorded.calls.push(name);
    return failing.has(name) ? Promise.reject(new WahaError("failed", "WAHA request failed")) : Promise.resolve();
  };
  return {
    sendSeen: () => call("seen"),
    startTyping: () => call("typing"),
    stopTyping: () => call("paused"),
    setOffline: () => call("offline"),
  } as unknown as WahaClient;
}

const quiet = { debug: () => undefined } as never;

function run(recorded: Recorded, over: { failing?: ReadonlySet<string>; random?: () => number; signal?: AbortSignal; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; kind?: "message" | "otp"; withSeen?: boolean; textLength?: number; beforeSend?: () => boolean; send?: () => Promise<string> } = {}) {
  const client = fakeClient(recorded, over.failing);
  const input: HumanSend<string> = {
    client,
    sessionName: "default",
    chatId: "628123456789@c.us",
    textLength: over.textLength ?? 90,
    kind: over.kind ?? "message",
    withSeen: over.withSeen ?? true,
    seenMessageId: "false_628123456789@c.us_AAAA",
    signal: over.signal ?? new AbortController().signal,
    ...(over.beforeSend === undefined ? {} : { beforeSend: over.beforeSend }),
    send: over.send ?? (() => {
      recorded.calls.push("send");
      return Promise.resolve("sent");
    }),
  };
  return sendLikeAHuman(
    {
      log: quiet,
      random: over.random,
      sleep: (ms, signal) => {
        recorded.waits.push(ms);
        return over.sleep === undefined ? Promise.resolve() : over.sleep(ms, signal);
      },
    },
    input,
  );
}

describe("the order of every WhatsApp send", () => {
  it("a reply: seen, a reading pause, typing, a wait, paused, a short pause, the send, then offline", async () => {
    const recorded: Recorded = { calls: [], waits: [] };
    const events: string[] = [];
    const out = await run(recorded, {
      sleep: () => {
        events.push(`wait:${recorded.calls.at(-1) ?? "start"}`);
        return Promise.resolve();
      },
    });
    expect(out).toEqual({ kind: "sent", value: "sent" });
    expect(recorded.calls).toEqual(["seen", "typing", "paused", "send", "offline"]);
    // Three waits: after seen (reading), after typing (the typing wait), after paused (the short pause).
    expect(events).toEqual(["wait:seen", "wait:typing", "wait:paused"]);
  });

  it("an opener has no message to read: typing, a wait, paused, a pause, the send, offline (no seen, no reading wait)", async () => {
    const recorded: Recorded = { calls: [], waits: [] };
    await run(recorded, { withSeen: false });
    expect(recorded.calls).toEqual(["typing", "paused", "send", "offline"]);
    expect(recorded.waits).toHaveLength(2);
  });

  it("an OTP is short: no reading step, typing at most 3 s and a pause of at most 0.9 s", async () => {
    for (let i = 0; i < 200; i++) {
      const recorded: Recorded = { calls: [], waits: [] };
      await run(recorded, { kind: "otp", withSeen: false, textLength: 70 });
      expect(recorded.calls).toEqual(["typing", "paused", "send", "offline"]);
      const [typing = 0, paused = 0] = recorded.waits;
      expect(typing).toBeGreaterThanOrEqual(HUMAN_TIMING.otpTyping[0]);
      expect(typing).toBeLessThanOrEqual(HUMAN_TIMING.otpTyping[1]);
      expect(paused).toBeLessThanOrEqual(HUMAN_TIMING.otpPaused[1]);
      expect(typing + paused).toBeLessThanOrEqual(4000);
    }
  });
});

describe("the pauses", () => {
  it("over N recipients each pause varies, stays within its bounds and is not the same twice in a row", async () => {
    const readings: number[] = [];
    const typings: number[] = [];
    const pauses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const recorded: Recorded = { calls: [], waits: [] };
      await run(recorded, { random: cryptoRandom, textLength: 40 + (i % 80) });
      const [reading = 0, typing = 0, paused = 0] = recorded.waits;
      readings.push(reading);
      typings.push(typing);
      pauses.push(paused);
    }
    for (const [values, [min, max]] of [[readings, HUMAN_TIMING.reading], [typings, HUMAN_TIMING.typing], [pauses, HUMAN_TIMING.paused]] as const) {
      expect(Math.min(...values)).toBeGreaterThanOrEqual(min);
      expect(Math.max(...values)).toBeLessThanOrEqual(max);
      expect(new Set(values).size).toBeGreaterThan(values.length * 0.6);
      expect(values.filter((v, i) => i > 0 && v === values[i - 1]).length).toBeLessThan(values.length * 0.03);
    }
  });

  it("the typing wait scales with the length of the message", async () => {
    const waitFor = async (length: number): Promise<number> => {
      const draws: number[] = [];
      for (let i = 0; i < 80; i++) {
        const recorded: Recorded = { calls: [], waits: [] };
        await run(recorded, { withSeen: false, textLength: length });
        draws.push(recorded.waits[0] ?? 0);
      }
      return draws.reduce((a, b) => a + b, 0) / draws.length;
    };
    expect(await waitFor(15)).toBeLessThan(await waitFor(120));
  });

  it("uses the random source it is given (a test can drive it), and the operating system's by default: two runs differ", async () => {
    const seeded = async (value: number) => {
      const recorded: Recorded = { calls: [], waits: [] };
      await run(recorded, { random: () => value });
      return recorded.waits;
    };
    expect(await seeded(0.5)).toEqual(await seeded(0.5));
    expect(await seeded(0.5)).not.toEqual(await seeded(0.9));
    const a: Recorded = { calls: [], waits: [] };
    const b: Recorded = { calls: [], waits: [] };
    await run(a);
    await run(b);
    expect(a.waits).not.toEqual(b.waits);
    for (let i = 0; i < 1000; i++) {
      const v = cryptoRandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seen, typing, paused and offline are best effort", () => {
  it("a failing typing call (and paused, seen, offline) lets the send proceed and does not change its result", async () => {
    for (const failing of [new Set(["typing"]), new Set(["seen"]), new Set(["paused"]), new Set(["offline"]), new Set(["seen", "typing", "paused", "offline"])]) {
      const recorded: Recorded = { calls: [], waits: [] };
      const out = await run(recorded, { failing });
      expect(out, [...failing].join()).toEqual({ kind: "sent", value: "sent" });
      expect(recorded.calls).toContain("send");
      // Every call is still attempted, in order (a failed typing start means no paused is sent for it).
      const expected = ["seen", "typing", ...(failing.has("typing") ? [] : ["paused"]), "send", "offline"];
      expect(recorded.calls).toEqual(expected);
    }
  });

  it("the send's own failure is the caller's: it propagates, and the session still goes offline", async () => {
    const recorded: Recorded = { calls: [], waits: [] };
    await expect(run(recorded, { send: () => Promise.reject(new WahaError("maybe_sent", "WAHA request failed")) })).rejects.toMatchObject({ code: "maybe_sent" });
    expect(recorded.calls.at(-1)).toBe("offline");
  });

  it("no call is held against the send: a slow presence call does not stop it (each has its own short budget in the adapter), and nothing is logged but a code", async () => {
    const recorded: Recorded = { calls: [], waits: [] };
    const lines: unknown[] = [];
    const client = fakeClient(recorded, new Set(["typing"]));
    await sendLikeAHuman(
      { log: { debug: (...args: unknown[]) => lines.push(args) } as never, sleep: () => Promise.resolve() },
      { client, sessionName: "default", chatId: "628123456789@c.us", textLength: 50, kind: "message", withSeen: false, signal: new AbortController().signal, send: () => Promise.resolve("x") },
    );
    expect(JSON.stringify(lines)).toContain('"step":"typing"');
    expect(JSON.stringify(lines)).toContain('"code":"failed"');
    expect(JSON.stringify(lines)).not.toContain("628123456789");
  });
});

describe("an abort or a lease that ends during a wait means nothing is sent", () => {
  it("an abort during any of the three waits is not_sent, the send is never called, and the session still goes offline (and stops typing)", async () => {
    for (const abortAt of [1, 2, 3]) {
      const recorded: Recorded = { calls: [], waits: [] };
      const controller = new AbortController();
      let wait = 0;
      const out = await run(recorded, {
        signal: controller.signal,
        sleep: () => {
          wait++;
          if (wait === abortAt) {
            controller.abort();
            return Promise.reject(new Error("aborted"));
          }
          return Promise.resolve();
        },
      });
      expect(out, `abort at wait ${String(abortAt)}`).toEqual({ kind: "not_sent", reason: "aborted" });
      expect(recorded.calls).not.toContain("send");
      expect(recorded.calls.at(-1)).toBe("offline");
      // Aborted while typing: typing is stopped before the session goes offline.
      if (abortAt === 2) expect(recorded.calls.slice(-2)).toEqual(["paused", "offline"]);
    }
  });

  it("a sleeper that resolves although the signal is already aborted does not send either", async () => {
    const recorded: Recorded = { calls: [], waits: [] };
    const controller = new AbortController();
    controller.abort();
    const out = await run(recorded, { signal: controller.signal });
    expect(out).toEqual({ kind: "not_sent", reason: "aborted" });
    expect(recorded.calls).not.toContain("send");
  });

  it("a lease that can no longer cover the send (checked after the last wait) is not_sent too, and nothing is sent", async () => {
    const recorded: Recorded = { calls: [], waits: [] };
    const out = await run(recorded, { beforeSend: () => false });
    expect(out).toEqual({ kind: "not_sent", reason: "too_late" });
    expect(recorded.calls).toEqual(["seen", "typing", "paused", "offline"]);
    const ok: Recorded = { calls: [], waits: [] };
    expect(await run(ok, { beforeSend: () => true })).toEqual({ kind: "sent", value: "sent" });
  });
});
