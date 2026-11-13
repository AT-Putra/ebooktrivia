import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString("utf8").split("\n")) if (line !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  return { lines, stream };
}

describe("createLogger", () => {
  it("redacts credentials, headers, sealed material and secret payload fields at any depth", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", role: "worker" }, stream);
    log.info(
      {
        authorization: "Bearer a",
        "x-api-key": "b",
        cookie: "c",
        headers: { "access-token": "d" },
        sealed: "e",
        request: { headers: { authorization: "f" }, method: "visible-method" },
        job: { data: { secret: "g", token: "h", password: "i", accessToken: "j", access_token: "k", keep: "visible" } },
        deep: { nested: { authorization: "l", cookie: "m", sealed: "n", "x-api-key": "o" } },
      },
      "hello",
    );
    const line = JSON.stringify(lines);
    for (const secret of ["Bearer a", '"b"', '"c"', '"d"', '"e"', '"f"', '"g"', '"h"', '"i"', '"j"', '"k"', '"l"', '"m"', '"n"', '"o"']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain("visible");
    expect(line).toContain("visible-method");
    expect(lines[0]).toMatchObject({ msg: "hello", role: "worker", level: 30, headers: "[redacted]" });
  });

  // Security review US-013 #5a: PII and URL-carried tokens.
  it.each(["phone", "email", "wa_chat_id", "msisdn", "to", "url", "pushUrl", "dsn", "payload"])("redacts %s at any depth", (key) => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", role: "worker" }, stream);
    log.info({ [key]: "pii-top", nested: { deeper: { [key]: { value: "pii-deep" } } }, kept: "visible" }, "pii");
    const line = JSON.stringify(lines);
    expect(line).not.toContain("pii-top");
    expect(line).not.toContain("pii-deep");
    expect(line).toContain("visible");
  });

  it("serializes errors without their attached properties (e.g. query parameters)", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", role: "internal" }, stream);
    const error = Object.assign(new Error("boom"), { code: "ET001", parameters: ["+6281234567890"], query: "SELECT 1" });
    log.error({ err: error }, "failed");
    const err = lines[0]?.["err"] as Record<string, unknown>;
    expect(err).toMatchObject({ type: "Error", message: "boom", code: "ET001" });
    expect(JSON.stringify(lines)).not.toContain("+6281234567890");
    expect(err["query"]).toBeUndefined();
  });

  it("redacts inside arrays, caps the depth and passes non-Error err values through", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", role: "worker" }, stream);
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    log.info({ list: [{ cookie: "c1" }, { ok: 1 }], deep, err: "plain text" }, "shapes");
    const line = lines[0] as { list: unknown[]; deep: unknown; err: unknown };
    expect(line.list).toEqual([{ cookie: "[redacted]" }, { ok: 1 }]);
    expect(JSON.stringify(line.deep)).toContain("[depth]");
    expect(line.err).toBe("plain text");
  });

  it("honours the level", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "warn", role: "worker" }, stream);
    log.info("quiet");
    log.warn("loud");
    expect(lines.map((l) => l["msg"])).toEqual(["loud"]);
  });
});
