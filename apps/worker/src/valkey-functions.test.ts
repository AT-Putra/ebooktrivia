// The loader of public's Valkey FUNCTION library (valkey-functions.ts), against a fake client: the real Valkey paths
// (a flushed library, the ACL) are test/prod-valkey-acl.int.test.ts's.
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { PUBLIC_VALKEY_LIBRARY, PUBLIC_VALKEY_LIBRARY_CODE, RATE_LIMIT_FUNCTION } from "@ebooktrivia/adapters/valkey-functions";
import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";
import { type FunctionLoaderClient, startValkeyFunctionLoader } from "./valkey-functions.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString("utf8").split("\n")) if (line !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  return { lines, log: createLogger({ level: "debug", role: "worker" }, stream) };
}

/** A client that answers FUNCTION LOAD and FCALL from queues (an Error answer rejects; the last answer repeats) and records every command. */
function fakeValkey(answers: { readonly load?: unknown[]; readonly fcall?: unknown[] } = {}) {
  const events = new EventEmitter();
  const commands: string[][] = [];
  const queues = { LOAD: [...(answers.load ?? [PUBLIC_VALKEY_LIBRARY])], FCALL: [...(answers.fcall ?? [[0, 0]])] };
  const client: FunctionLoaderClient = {
    call: (command, ...args) => {
      commands.push([command, ...args.map(String)]);
      const queue = command === "FUNCTION" ? queues.LOAD : queues.FCALL;
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
  };
  return { client, commands, events };
}

describe("startValkeyFunctionLoader", () => {
  it("loads the library at start (FUNCTION LOAD REPLACE with the library's code) and reloads on every later ready, until stopped", async () => {
    const { client, commands, events } = fakeValkey();
    const { log, lines } = capture();
    const loader = await startValkeyFunctionLoader(client, log);
    expect(commands).toEqual([["FUNCTION", "LOAD", "REPLACE", PUBLIC_VALKEY_LIBRARY_CODE]]);
    expect(lines.filter((l) => l["msg"] === "valkey functions loaded").map((l) => l["reason"])).toEqual(["start"]);
    expect(events.listenerCount("ready")).toBe(1);

    events.emit("ready");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.filter((l) => l["msg"] === "valkey functions loaded").map((l) => l["reason"])).toEqual(["start", "reconnect"]);

    loader.stop();
    expect(events.listenerCount("ready")).toBe(0);
    events.emit("ready");
    await new Promise((resolve) => setImmediate(resolve));
    expect(commands.filter((c) => c[0] === "FUNCTION")).toHaveLength(2);
  });

  it("logs a failed load as an error, answers false, and keeps running (the next ready or heartbeat retries)", async () => {
    const { client, events } = fakeValkey({ load: [new Error("LOADING Valkey is loading the dataset in memory"), PUBLIC_VALKEY_LIBRARY] });
    const { log, lines } = capture();
    const loader = await startValkeyFunctionLoader(client, log);
    const failure = lines.find((l) => l["msg"] === "valkey functions could not be loaded: public answers 503 on its rate-limited routes");
    expect(failure).toMatchObject({ level: 50, reason: "start", library: PUBLIC_VALKEY_LIBRARY });
    // The loader is up all the same: a ready after the failed start loads it.
    expect(events.listenerCount("ready")).toBe(1);
    events.emit("ready");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.find((l) => l["msg"] === "valkey functions loaded")).toMatchObject({ reason: "reconnect" });
    expect(await loader.load("missing")).toBe(true);
  });

  it("treats a reply that is not the library's name as a failed load", async () => {
    const { client } = fakeValkey({ load: ["some_other_library"] });
    const { log, lines } = capture();
    const loader = await startValkeyFunctionLoader(client, log);
    expect(await loader.load("reconnect")).toBe(false);
    expect(lines.filter((l) => String(l["msg"]).startsWith("valkey functions could not be loaded")).map((l) => l["reason"])).toEqual(["start", "reconnect"]);
    expect(lines.some((l) => l["msg"] === "valkey functions loaded")).toBe(false);
  });

  describe("check (the heartbeat's probe)", () => {
    it("is true and loads nothing when the function answers", async () => {
      const { client, commands } = fakeValkey({ fcall: [[0, 0]] });
      const loader = await startValkeyFunctionLoader(client, capture().log);
      expect(await loader.check()).toBe(true);
      expect(commands.at(-1)).toEqual(["FCALL", RATE_LIMIT_FUNCTION, "0"]);
      expect(commands.filter((c) => c[0] === "FUNCTION")).toHaveLength(1);
    });

    it("is false, with no reload and no alert, when the ACL refuses FCALL or Valkey is unreachable", async () => {
      for (const error of [new Error("NOPERM User public has no permissions to run the 'fcall' command"), new Error("connect ECONNREFUSED 127.0.0.1:1")]) {
        const { client, commands } = fakeValkey({ fcall: [error] });
        let alerts = 0;
        const loader = await startValkeyFunctionLoader(client, capture().log, () => {
          alerts++;
          return Promise.resolve();
        });
        expect(await loader.check()).toBe(false);
        expect(alerts).toBe(0);
        expect(commands.filter((c) => c[0] === "FUNCTION")).toHaveLength(1);
      }
    });

    it("finding the function missing: warns, raises the alert once, reloads it, and answers whether the reload worked", async () => {
      const { client, commands } = fakeValkey({ fcall: [new Error("ERR Function not found")] });
      const { log, lines } = capture();
      let alerts = 0;
      const loader = await startValkeyFunctionLoader(client, log, () => {
        alerts++;
        return Promise.resolve();
      });
      expect(await loader.check()).toBe(true);
      expect(alerts).toBe(1);
      expect(lines.find((l) => l["msg"] === "valkey function missing: reloading it")).toMatchObject({ level: 40, library: PUBLIC_VALKEY_LIBRARY });
      expect(commands.filter((c) => c[0] === "FUNCTION")).toHaveLength(2);
      expect(lines.filter((l) => l["msg"] === "valkey functions loaded").map((l) => l["reason"])).toEqual(["start", "missing"]);
    });

    it("still reloads when the alert cannot be raised (logged), and answers false when the reload fails too", async () => {
      const { client } = fakeValkey({ load: [PUBLIC_VALKEY_LIBRARY, new Error("OOM command not allowed")], fcall: [new Error("ERR Function not found")] });
      const { log, lines } = capture();
      const loader = await startValkeyFunctionLoader(client, log, () => Promise.reject(new Error("postgres is down")));
      expect(await loader.check()).toBe(false);
      expect(lines.find((l) => l["msg"] === "the valkey_function_missing alert could not be raised")).toMatchObject({ level: 50 });
      expect(lines.find((l) => l["msg"] === "valkey functions could not be loaded: public answers 503 on its rate-limited routes")).toMatchObject({ reason: "missing" });
    });
  });
});
