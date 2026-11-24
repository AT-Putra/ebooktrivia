// The human-like sequence of every WhatsApp send (US-025, Owner requirement; human.ts): the order of the calls, the pauses (random, bounded, never
// equal for consecutive recipients), the whole chat marked as read before anything else (every kind, never with a message id), best-effort presence calls that never
// touch the send, and no send at all when the job is aborted during a wait.
import { createWahaClient, type HttpResponse, WahaError, type WahaClient } from "@ebooktrivia/adapters";
import { HUMAN_TIMING } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { cryptoRandom, type HumanSend, sendLikeAHuman } from "./human.ts";

interface Recorded {
  readonly calls: string[];
  readonly waits: number[];
  /** The message ids of every sendSeen call (undefined: the whole chat). */
  readonly seenIds: (readonly string[] | undefined)[];
}

const recording = (): Recorded => ({ calls: [], waits: [], seenIds: [] });

/** A WAHA client that records the order of the calls (never a text), with optional failures by call name. */
function fakeClient(recorded: Recorded, failing: ReadonlySet<string> = new Set()): WahaClient {
  const call = (name: string): Promise<void> => {
    recorded.calls.push(name);
    return failing.has(name) ? Promise.reject(new WahaError("failed", "WAHA request failed")) : Promise.resolve();
  };
  return {
    sendSeen: (_session: string, _chat: string, ids?: readonly string[]) => {
      recorded.seenIds.push(ids);
      return call("seen");
    },
    startTyping: () => call("typing"),
    stopTyping: () => call("paused"),
    setOffline: () => call("offline"),
  } as unknown as WahaClient;
}

const quiet = { debug: () => undefined } as never;

function run(recorded: Recorded, over: { failing?: ReadonlySet<string>; random?: () => number; signal?: AbortSignal; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; kind?: "message" | "otp"; textLength?: number; beforeSend?: () => boolean; send?: () => Promise<string> } = {}) {
  const client = fakeClient(recorded, over.failing);
  const input: HumanSend<string> = {
    client,
    sessionName: "default",
    chatId: "628123456789@c.us",
    textLength: over.textLength ?? 90,
    kind: over.kind ?? "message",
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
  it("every send: seen, a reading pause, typing, a wait, paused, a short pause, the send, then offline", async () => {
    const recorded: Recorded = recording();
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

  it("the whole chat is marked as read, with no message id, before typing starts, for a message of any length (there is no caller-side switch: openers, replies, files and test-sends all go through here)", async () => {
    for (const textLength of [0, 12, 90, 400]) {
      const recorded: Recorded = recording();
      await run(recorded, { textLength });
      expect(recorded.calls.slice(0, 2), String(textLength)).toEqual(["seen", "typing"]);
      expect(recorded.seenIds).toEqual([undefined]);
    }
  });

  it("an OTP is short: the chat is marked as read, but there is no reading pause; typing at most 3 s and a pause of at most 0.9 s", async () => {
    for (let i = 0; i < 200; i++) {
      const recorded: Recorded = recording();
      await run(recorded, { kind: "otp", textLength: 70 });
      expect(recorded.calls).toEqual(["seen", "typing", "paused", "send", "offline"]);
      expect(recorded.seenIds).toEqual([undefined]);
      // Two waits only (typing, the short pause): the seen mark is followed by no reading wait.
      expect(recorded.waits).toHaveLength(2);
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
      const recorded: Recorded = recording();
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
        const recorded: Recorded = recording();
        await run(recorded, { textLength: length });
        // The first wait is the reading pause, the second the typing wait.
        draws.push(recorded.waits[1] ?? 0);
      }
      return draws.reduce((a, b) => a + b, 0) / draws.length;
    };
    expect(await waitFor(15)).toBeLessThan(await waitFor(120));
  });

  it("uses the random source it is given (a test can drive it), and the operating system's by default: two runs differ", async () => {
    const seeded = async (value: number) => {
      const recorded: Recorded = recording();
      await run(recorded, { random: () => value });
      return recorded.waits;
    };
    expect(await seeded(0.5)).toEqual(await seeded(0.5));
    expect(await seeded(0.5)).not.toEqual(await seeded(0.9));
    const a: Recorded = recording();
    const b: Recorded = recording();
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
      const recorded: Recorded = recording();
      const out = await run(recorded, { failing });
      expect(out, [...failing].join()).toEqual({ kind: "sent", value: "sent" });
      expect(recorded.calls).toContain("send");
      // Every call is still attempted, in order (a failed typing start means no paused is sent for it).
      const expected = ["seen", "typing", ...(failing.has("typing") ? [] : ["paused"]), "send", "offline"];
      expect(recorded.calls).toEqual(expected);
    }
  });

  it("the send's own failure is the caller's: it propagates, and the session still goes offline", async () => {
    const recorded: Recorded = recording();
    await expect(run(recorded, { send: () => Promise.reject(new WahaError("maybe_sent", "WAHA request failed")) })).rejects.toMatchObject({ code: "maybe_sent" });
    expect(recorded.calls.at(-1)).toBe("offline");
  });

  it("no call is held against the send: a slow presence call does not stop it (each has its own short budget in the adapter), and nothing is logged but a code", async () => {
    const recorded: Recorded = recording();
    const lines: unknown[] = [];
    const client = fakeClient(recorded, new Set(["typing"]));
    await sendLikeAHuman(
      { log: { debug: (...args: unknown[]) => lines.push(args) } as never, sleep: () => Promise.resolve() },
      { client, sessionName: "default", chatId: "628123456789@c.us", textLength: 50, kind: "message", signal: new AbortController().signal, send: () => Promise.resolve("x") },
    );
    expect(JSON.stringify(lines)).toContain('"step":"typing"');
    expect(JSON.stringify(lines)).toContain('"code":"failed"');
    expect(JSON.stringify(lines)).not.toContain("628123456789");
  });
});

describe("an abort or a lease that ends during a wait means nothing is sent", () => {
  it("an abort during any of the three waits is not_sent, the send is never called, and the session still goes offline (and stops typing)", async () => {
    for (const abortAt of [1, 2, 3]) {
      const recorded: Recorded = recording();
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
    const recorded: Recorded = recording();
    const controller = new AbortController();
    controller.abort();
    const out = await run(recorded, { signal: controller.signal });
    expect(out).toEqual({ kind: "not_sent", reason: "aborted" });
    expect(recorded.calls).not.toContain("send");
  });

  it("a lease that can no longer cover the send (checked after the last wait) is not_sent too, and nothing is sent", async () => {
    const recorded: Recorded = recording();
    const out = await run(recorded, { beforeSend: () => false });
    expect(out).toEqual({ kind: "not_sent", reason: "too_late" });
    expect(recorded.calls).toEqual(["seen", "typing", "paused", "offline"]);
    const ok: Recorded = recording();
    expect(await run(ok, { beforeSend: () => true })).toEqual({ kind: "sent", value: "sent" });
  });
});

// US-005 (R11): the REAL adapter client against the answers the Owner's WEBJS instance recorded for these calls. WEBJS answers 201 with NO BODY to a presence call and
// to sendSeen with message ids; the adapter used to throw on that, so startTyping "failed", `typing` stayed false and the "paused" step never ran (the session was
// left typing until the finally block went offline). Each call must now succeed, and the sequence must stop typing before the send.
describe("the sequence against the answers WEBJS recorded (US-005 R11)", () => {
  const target = new URL("https://waha.example.id:3000/");
  const CHAT = "98765432101234@lid";

  function webjsClient(log: string[]): WahaClient {
    return createWahaClient({
      target,
      apiKey: "key",
      fetch: (url, init) => {
        const path = new URL(url).pathname;
        const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        log.push(`${path}${typeof body["presence"] === "string" ? `:${body["presence"]}` : ""}${Array.isArray(body["messageIds"]) ? ":with-message-ids" : ""}`);
        const answer = (status: number, text: string): Promise<HttpResponse> =>
          Promise.resolve({ status, json: () => Promise.resolve(JSON.parse(text) as unknown), text: () => Promise.resolve(text) });
        if (path.endsWith("/presence")) return answer(201, "");
        if (path === "/api/sendSeen") return Array.isArray(body["messageIds"]) ? answer(201, "") : answer(201, '{"ids":null}');
        return Promise.reject(new Error(`unexpected call ${path}`));
      },
    });
  }

  it("a send runs every step: seen (the whole chat), typing, PAUSED, the send, offline, and no best-effort call fails", async () => {
    const wire: string[] = [];
    const failures: string[] = [];
    const out = await sendLikeAHuman(
      { log: { debug: (fields: unknown) => failures.push(JSON.stringify(fields)) } as never, sleep: () => Promise.resolve() },
      {
        client: webjsClient(wire),
        sessionName: "default",
        chatId: CHAT,
        textLength: 90,
        kind: "message",
        signal: new AbortController().signal,
        send: () => {
          wire.push("SEND");
          return Promise.resolve("sent");
        },
      },
    );
    expect(out).toEqual({ kind: "sent", value: "sent" });
    expect(wire).toEqual(["/api/sendSeen", "/api/default/presence:typing", "/api/default/presence:paused", "SEND", "/api/default/presence:offline"]);
    expect(failures).toEqual([]);
  });

  it("an OTP marks the chat as read too (no reading pause); seen without ids answers {ids: null} and is fine", async () => {
    const wire: string[] = [];
    const failures: string[] = [];
    const waits: number[] = [];
    await sendLikeAHuman(
      {
        log: { debug: (fields: unknown) => failures.push(JSON.stringify(fields)) } as never,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
      { client: webjsClient(wire), sessionName: "default", chatId: CHAT, textLength: 60, kind: "otp", signal: new AbortController().signal, send: () => Promise.resolve("sent") },
    );
    expect(wire).toEqual(["/api/sendSeen", "/api/default/presence:typing", "/api/default/presence:paused", "/api/default/presence:offline"]);
    expect(waits).toHaveLength(2);
    const seenOnly: string[] = [];
    await webjsClient(seenOnly).sendSeen("default", CHAT);
    expect(seenOnly).toEqual(["/api/sendSeen"]);
    expect(failures).toEqual([]);
  });
});
