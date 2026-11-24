// The play routes' call discipline (US-027, code review MINOR-3), with a fake sql: a WRITE that PostgreSQL aborts
// as a deadlock (40P01) runs exactly once more; nothing else is retried, a read never is, and a refusal is its error.
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Sql } from "../db.ts";
import type { PlayDeps } from "./handlers.ts";
import { handleAnswer, handleCurrent, handleStartSet } from "./trivia.ts";

const ID = "6a1f8f2e-1c3b-4d5e-9f00-1234567890ab";
const OTHER = "7b2f8f2e-1c3b-4d5e-9f00-1234567890ab";

/** A fake tagged-template sql: each call gets the next scripted result (a value, or an error to throw). */
function fakeSql(script: readonly (unknown[] | Error)[]): { readonly sql: Sql; readonly calls: string[] } {
  const calls: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    calls.push(/public\.(play_\w+)/.exec(text)?.[1] ?? text);
    const next = script[calls.length - 1];
    if (next === undefined) return Promise.reject(new Error("unexpected call"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { sql: sql as unknown as Sql, calls };
}

const pgError = (code: string) => Object.assign(new postgres.PostgresError("x"), { code });
const deps = (sql: Sql) => ({ sql, log: () => undefined }) as unknown as PlayDeps;
const post = (body: unknown) => new Request("https://play.example.test/api/v1/play/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("40P01: one retry of a write", () => {
  it("retries a start once after a deadlock, then answers", async () => {
    const { sql, calls } = fakeSql([pgError("40P01"), [{ id: ID }]]);
    const response = await handleStartSet(deps(sql), post({ set_id: OTHER }), ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ v: 1, attempt_id: ID });
    expect(calls).toEqual(["play_start_set", "play_start_set"]);
  });

  it("does not retry a second deadlock, nor any other error", async () => {
    const twice = fakeSql([pgError("40P01"), pgError("40P01"), [{ id: ID }]]);
    await expect(handleStartSet(deps(twice.sql), post({ set_id: OTHER }), ID)).rejects.toMatchObject({ code: "40P01" });
    expect(twice.calls).toHaveLength(2);
    const refused = fakeSql([pgError("ET142"), [{ id: ID }]]);
    expect(await (await handleStartSet(deps(refused.sql), post({ set_id: OTHER }), ID)).json()).toEqual({ v: 1, error: "locked" });
    expect(refused.calls).toHaveLength(1);
  });

  it("retries the answer's writes (the pick, the settle), never its read: pick, pick, settle, settle, reveal", async () => {
    const settled = [{ r: { state: "settled", answer_id: ID } }];
    const { sql, calls } = fakeSql([pgError("40P01"), [{ r: { state: "answered", answer_id: ID } }], pgError("40P01"), settled, [{ r: { state: "revealed", correct: true, correct_option_id: OTHER } }]]);
    const response = await handleAnswer(deps(sql), post({ answer_id: ID, option_id: OTHER }), ID);
    expect(await response.json()).toEqual({ v: 1, state: "answered", correct: true, correct_option_id: OTHER });
    expect(calls).toEqual(["play_answer", "play_answer", "play_settle", "play_settle", "play_reveal"]);
    const readFails = fakeSql([[{ r: { state: "answered" } }], settled, pgError("40P01")]);
    await expect(handleAnswer(deps(readFails.sql), post({ answer_id: ID, option_id: OTHER }), ID)).rejects.toMatchObject({ code: "40P01" });
    expect(readFails.calls).toEqual(["play_answer", "play_settle", "play_reveal"]);
  });

  it("answers an already-answered question (a retry after a failed reveal) with the reveal of the committed pick; a timeout stays 409", async () => {
    const recorded = { state: "revealed", option_id: OTHER, correct: false };
    const retry = fakeSql([pgError("ET144"), [{ r: { state: "settled" } }], [{ r: recorded }]]);
    expect(await (await handleAnswer(deps(retry.sql), post({ answer_id: ID, option_id: ID }), ID)).json()).toEqual({ v: 1, ...recorded, state: "answered" });
    expect(retry.calls).toEqual(["play_answer", "play_settle", "play_reveal"]);
    const timedOut = fakeSql([pgError("ET144"), [{ r: { state: "settled" } }], pgError("ET148")]);
    const refused = await handleAnswer(deps(timedOut.sql), post({ answer_id: ID, option_id: ID }), ID);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ v: 1, error: "already_answered" });
    // US-031: a retry more than 60 s after the answer: play_reveal refuses it ("closed"), the same 409, nothing revealed.
    const stale = fakeSql([pgError("ET144"), [{ r: { state: "settled" } }], [{ r: { state: "closed", answer_id: ID } }]]);
    const late = await handleAnswer(deps(stale.sql), post({ answer_id: ID, option_id: ID }), ID);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ v: 1, error: "already_answered" });
  });

  it("shows the question from the call after a serve, adding up the timeouts the calls closed", async () => {
    const { sql, calls } = fakeSql([[{ r: { state: "served", timed_out: 1 } }], [{ r: { state: "question", answer_id: ID, timed_out: 0 } }]]);
    expect(await (await handleCurrent(deps(sql), post({ attempt_id: ID }), ID)).json()).toEqual({ v: 1, state: "question", answer_id: ID, timed_out: 1 });
    expect(calls).toEqual(["play_current", "play_current"]);
  });
});

describe("a refusal from ANOTHER copy of postgres.js (the runtime's pool was built by a page or the proxy, another bundle)", () => {
  /** What another bundle's postgres.js throws: an Error with the server's fields, not this module's PostgresError class. */
  const otherCopy = (code: string) => Object.assign(new Error("x"), { severity: "ERROR", code });

  it("is still its refusal (409 already_answered, too_late, closed...), never a 503", async () => {
    for (const [code, error] of [
      ["ET144", "already_answered"],
      ["ET109", "too_late"],
      ["ET110", "closed"],
      ["ET142", "locked"],
      ["ET140", "forbidden"],
    ] as const) {
      const { sql } = fakeSql([otherCopy(code)]);
      const response = await handleStartSet(deps(sql), post({ set_id: OTHER }), ID);
      expect(await response.json(), code).toEqual({ v: 1, error });
    }
  });

  it("a deadlock is still retried once, and an already-answered retry still gets the committed pick's reveal", async () => {
    const start = fakeSql([otherCopy("40P01"), [{ id: ID }]]);
    expect((await handleStartSet(deps(start.sql), post({ set_id: OTHER }), ID)).status).toBe(200);
    expect(start.calls).toEqual(["play_start_set", "play_start_set"]);
    const recorded = { state: "revealed", option_id: OTHER, correct: false };
    const retry = fakeSql([otherCopy("ET144"), [{ r: { state: "settled" } }], [{ r: recorded }]]);
    expect(await (await handleAnswer(deps(retry.sql), post({ answer_id: ID, option_id: ID }), ID)).json()).toEqual({ v: 1, ...recorded, state: "answered" });
  });

  it("a Node system error (no severity) is still not a refusal: thrown (the route answers 503), never retried", async () => {
    const { sql, calls } = fakeSql([Object.assign(new Error("write EPIPE"), { code: "EPIPE" }), [{ id: ID }]]);
    await expect(handleStartSet(deps(sql), post({ set_id: OTHER }), ID)).rejects.toThrow("write EPIPE");
    expect(calls).toHaveLength(1);
  });
});
