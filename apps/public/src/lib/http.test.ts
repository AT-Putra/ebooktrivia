import { describe, expect, it } from "vitest";
import { allowedOrigin, errorResponse, MAX_BODY_BYTES, originRefused, originsOf, preflight, readJsonBody, STATUS } from "./http.ts";
import { formatLogLine, maskText } from "./log.ts";

const req = (headers: Record<string, string>, body?: BodyInit, method = "POST") => new Request("https://api.example.id/x", { method, headers, ...(body === undefined ? {} : { body }) });

describe("CORS per landing page", () => {
  const allowed = originsOf(["lp.example.id", "promo.example.co.id"]);

  it("allows exactly https:// + a registered host", () => {
    expect(allowedOrigin(req({ origin: "https://lp.example.id" }), allowed)).toBe("https://lp.example.id");
    for (const origin of ["http://lp.example.id", "https://LP.example.id", "https://lp.example.id:443", "https://lp.example.id/", "https://x.lp.example.id", "null"]) {
      expect(allowedOrigin(req({ origin }), allowed), origin).toBeNull();
    }
    expect(allowedOrigin(req({}), allowed)).toBeNull();
  });

  it("answers a preflight for an allowed origin only, never with credentials", () => {
    const ok = preflight(req({ origin: "https://lp.example.id", "access-control-request-method": "POST" }, undefined, "OPTIONS"), "https://lp.example.id");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toBe("content-type, accept");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight(req({}, undefined, "OPTIONS"), null).status).toBe(403);
    expect(preflight(req({ "access-control-request-method": "DELETE" }, undefined, "OPTIONS"), "https://lp.example.id").status).toBe(403);
  });

  it("maps every error code to the contract's status; an origin refusal has no CORS header", async () => {
    expect(STATUS).toEqual({ validation: 400, captcha: 403, origin: 403, sales_closed: 409, rate_limited: 429, gateway: 502, unavailable: 503 });
    const refused = originRefused();
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(await refused.json()).toEqual({ v: 1, error: "origin" });
    const fields = errorResponse("validation", "https://lp.example.id", { fields: { phone: "not_mobile" } });
    expect(fields.headers.get("access-control-allow-origin")).toBe("https://lp.example.id");
    expect(await fields.json()).toEqual({ v: 1, error: "validation", fields: { phone: "not_mobile" } });
  });
});

describe("readJsonBody", () => {
  it("reads JSON up to the limit and refuses the rest", async () => {
    expect(await readJsonBody(req({ "content-type": "application/json; charset=utf-8" }, '{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJsonBody(req({ "content-type": "text/plain" }, '{"a":1}'))).toEqual({ ok: false });
    expect(await readJsonBody(req({ "content-type": "application/jsonx" }, '{"a":1}'))).toEqual({ ok: false });
    expect(await readJsonBody(req({ "content-type": "application/json" }, "{"))).toEqual({ ok: false });
    expect(await readJsonBody(req({ "content-type": "application/json" }))).toEqual({ ok: false });
    expect(await readJsonBody(req({ "content-type": "application/json" }, new Uint8Array([0x22, 0xff, 0x22])))).toEqual({ ok: false });
    const big = JSON.stringify({ a: "x".repeat(MAX_BODY_BYTES) });
    expect(await readJsonBody(req({ "content-type": "application/json" }, big))).toEqual({ ok: false });
    // A lying Content-Length does not help: the stream is counted.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        controller.close();
      },
    });
    expect(await readJsonBody(new Request("https://api.example.id/x", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit))).toEqual({ ok: false });
    expect(await readJsonBody(req({ "content-type": "application/json", "content-length": "99999" }, "{}"))).toEqual({ ok: false });
  });
});

describe("logs", () => {
  it("keeps allowlisted fields only and masks free text", () => {
    const line = JSON.parse(formatLogLine("warn", "checkout.refused", { reason: "x", phone: "+6281234567890", email: "a@b.id", detail: "buyer +62 812-3456-7890 a@b.id" })) as Record<string, unknown>;
    expect(line).toEqual({ level: "warn", role: "public", event: "checkout.refused", reason: "x", detail: "buyer [number] [email]", droppedFields: 2 });
    expect(maskText("token AbCdEf0123456789XyZ")).toBe("token [token]");
    expect(JSON.parse(formatLogLine("error", "Bad Event!", {}, Object.assign(new Error("Key (email)=(a@b.id)"), { code: "23505" })))).toEqual({ level: "error", role: "public", event: "invalid_event_name", errorType: "Error", errorCode: "23505" });
  });
});
