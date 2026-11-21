import type { FetchedMessage, WahaClient } from "@ebooktrivia/adapters";
import { describe, expect, it } from "vitest";
import { READBACK_TIMEOUT_MS } from "./config.ts";
import { DELIVERED_WRONG_FILE, deliveredSize, FILE_UNAVAILABLE, wrongFile } from "./file-check.ts";

const lines: { level: string; fields: unknown }[] = [];
const log = {
  debug: (fields: unknown) => lines.push({ level: "debug", fields }),
  info: (fields: unknown) => lines.push({ level: "info", fields }),
  warn: (fields: unknown) => lines.push({ level: "warn", fields }),
  error: (fields: unknown) => lines.push({ level: "error", fields }),
} as unknown as Parameters<typeof deliveredSize>[3];
const ID = "true_98765432101234@lid_3EB0C767D0D2E0A1F4B3C2";
const message = (mediaSize?: number): FetchedMessage => ({ messageId: ID, chat: { kind: "lid" } as never, fromMe: true, body: "", hasMedia: true, timestamp: 1_795_266_751, ...(mediaSize === undefined ? {} : { mediaSize }) });
const clientOf = (getMessage: WahaClient["getMessage"]): WahaClient => ({ getMessage }) as unknown as WahaClient;

describe("the read-back of a sent file", () => {
  it("asks WAHA with a SHORT budget of its own (READBACK_TIMEOUT_MS), never the client's whole-request timeout: it runs inside the claim's lease", async () => {
    const asked: unknown[] = [];
    const client = clientOf((_session, _id, options) => {
      asked.push(options);
      return Promise.resolve(message(13_264));
    });
    expect(await deliveredSize(client, "default", ID, log)).toBe(13_264);
    expect(asked).toEqual([{ timeoutMs: READBACK_TIMEOUT_MS }]);
    expect(READBACK_TIMEOUT_MS).toBe(3000);
  });

  it("an unknown size is never an error: a failed or timed-out read, an unknown message and an engine that reports no size are all `undefined` (a debug line, a code only)", async () => {
    lines.length = 0;
    const timedOut = Object.assign(new Error("budget over"), { code: "failed" });
    expect(await deliveredSize(clientOf(() => Promise.reject(timedOut)), "default", ID, log)).toBeUndefined();
    expect(await deliveredSize(clientOf(() => Promise.resolve(null)), "default", ID, log)).toBeUndefined();
    expect(await deliveredSize(clientOf(() => Promise.resolve(message())), "default", ID, log)).toBeUndefined();
    expect(lines.every((l) => l.level === "debug")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("98765432101234");
  });

  it("compares a known delivered size with the stored one only", () => {
    expect(wrongFile(13_264, 13_264)).toBeUndefined();
    expect(wrongFile(13_264, undefined)).toBeUndefined();
    expect(wrongFile(13_264, 21_483)).toEqual({ expected: 13_264, delivered: 21_483 });
    expect([DELIVERED_WRONG_FILE, FILE_UNAVAILABLE]).toEqual(["delivered_wrong_file", "file_unavailable"]);
  });
});
