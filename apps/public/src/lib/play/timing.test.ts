import { ANSWER_LATENCY_GRACE_MS } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { LATENCY_GRACE_MS } from "./timing.ts";

describe("the question screen's timing", () => {
  it("waits out the same latency grace as the server (core ANSWER_LATENCY_GRACE_MS, sql/play.sql)", () => {
    expect(LATENCY_GRACE_MS).toBe(ANSWER_LATENCY_GRACE_MS);
  });
});
