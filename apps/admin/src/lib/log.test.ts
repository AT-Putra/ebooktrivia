import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuthApiError, betterAuthLog, formatLogLine, maskText } from "./log.ts";

const EMAIL = "owner@example.test";
const TOKEN = "pX4kq9Lz2VbN7sQwE1rT";

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatLogLine", () => {
  it("keeps allowlisted primitive fields", () => {
    expect(JSON.parse(formatLogLine("info", "admin_auth.sign_in", { userId: "u1", outcome: "ok", count: 2 }))).toEqual({
      level: "info",
      role: "admin",
      event: "admin_auth.sign_in",
      userId: "u1",
      outcome: "ok",
      count: 2,
    });
  });

  it("drops every other field, so an e-mail, phone or password cannot be logged", () => {
    const line = formatLogLine("warn", "admin_auth.sign_in_failed", {
      email: EMAIL,
      phone: "+6281234567890",
      password: "hunter2-hunter2",
      ip: "198.51.100.7",
      userId: "u1",
    });
    expect(JSON.parse(line)).toEqual({ level: "warn", role: "admin", event: "admin_auth.sign_in_failed", userId: "u1", droppedFields: 4 });
    for (const secret of [EMAIL, "6281234567890", "hunter2", "198.51.100.7"]) expect(line).not.toContain(secret);
  });

  it("reduces errors to type and code, never the message or driver detail", () => {
    const error = Object.assign(new Error(`duplicate key value (email)=(${EMAIL})`), { code: "23505", detail: `Key (email)=(${EMAIL}) already exists.` });
    const line = formatLogLine("error", "admin.request_failed", {}, error);
    expect(JSON.parse(line)).toEqual({ level: "error", role: "admin", event: "admin.request_failed", errorType: "Error", errorCode: "23505" });
    expect(line).not.toContain(EMAIL);
    expect(JSON.parse(formatLogLine("error", "x", {}, "boom"))).toMatchObject({ errorType: "string" });
    expect(JSON.parse(formatLogLine("error", "x", {}, Object.assign(new Error("m"), { code: "a b@c" })))).not.toHaveProperty("errorCode");
  });

  it("masks free text in `detail`", () => {
    const line = formatLogLine("warn", "x", { detail: `user ${EMAIL} token ${TOKEN} phone +62 812-3456-7890 ok` });
    expect(JSON.parse(line)).toMatchObject({ detail: "user [email] token [token] phone [number] ok" });
  });

  it("refuses free-text event names", () => {
    expect(JSON.parse(formatLogLine("info", `login by ${EMAIL}`))).toMatchObject({ event: "invalid_event_name" });
  });
});

describe("maskText", () => {
  it("masks hex and base64 tokens, keeps plain words, cuts long text", () => {
    expect(maskText(`secret ${"a1".repeat(32)} and Zm9vYmFyYmF6cXV4cXV1eA==`)).toBe("secret [token] and [token]");
    expect(maskText("Failed to create session for user")).toBe("Failed to create session for user");
    expect(maskText("x".repeat(500))).toHaveLength(200);
  });
});

describe("Better Auth log adapters", () => {
  it("log Better Auth messages masked and drop their extra arguments", () => {
    const out = captureStderr();
    betterAuthLog("error", `Failed to verify ${EMAIL} with token ${TOKEN}`);
    betterAuthLog("warn", "Base URL is not set");
    betterAuthLog("debug", `debug ${EMAIL}`);
    const text = out.text();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(TOKEN);
    expect(text.trim().split("\n").map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(["better_auth.log", "better_auth.log"]);
  });

  it("log an API error by type and code only", () => {
    const out = captureStderr();
    betterAuthApiError(Object.assign(new Error(`Failing row contains (${EMAIL}, ${TOKEN})`), { code: "23514" }));
    expect(out.text()).not.toContain(EMAIL);
    expect(out.text()).not.toContain(TOKEN);
    expect(JSON.parse(out.text())).toMatchObject({ event: "better_auth.api_error", errorType: "Error", errorCode: "23514" });
  });
});
