import { describe, expect, it } from "vitest";
import { type LoginFetch, loginAll } from "./login.ts";

const answer = (status: number, cookies: string[] = [], retryAfter?: string): Awaited<ReturnType<LoginFetch>> => ({
  status,
  headers: { get: (name) => (name === "retry-after" ? (retryAfter ?? null) : null), getSetCookie: () => cookies },
});

describe("loginAll", () => {
  it("posts each token to the play origin's magic-link route with the exact Origin and keeps only name=value of the session cookie, in order", async () => {
    const seen: { url: string; origin: string | undefined; body: unknown }[] = [];
    const sessions = await loginAll({
      playOrigin: "https://play.example.test",
      tokens: ["t0", "t1", "t2"],
      concurrency: 2,
      fetch: (url, init) => {
        const body = JSON.parse(init.body) as { token: string };
        seen.push({ url, origin: init.headers["origin"], body });
        return Promise.resolve(answer(200, ["other=1; Path=/", `__Host-play_session=${body.token}.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`]));
      },
    });
    expect(sessions.map((s) => s.cookie)).toEqual(["__Host-play_session=t0.sig", "__Host-play_session=t1.sig", "__Host-play_session=t2.sig"]);
    expect(seen.map((s) => s.url)).toEqual(Array(3).fill("https://play.example.test/api/v1/play/auth/magic-link"));
    expect(seen.every((s) => s.origin === "https://play.example.test")).toBe(true);
    expect(seen[0]?.body).toEqual({ channel: "whatsapp", token: "t0" });
  });

  it("waits out a 429 for Retry-After seconds and retries the same token", async () => {
    const waits: number[] = [];
    let calls = 0;
    const sessions = await loginAll({
      playOrigin: "https://play.example.test",
      tokens: ["t0"],
      concurrency: 1,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      fetch: () => Promise.resolve(++calls < 3 ? answer(429, [], "42") : answer(200, ["__Host-play_session=ok"])),
    });
    expect(waits).toEqual([42_000, 42_000]);
    expect(sessions).toEqual([{ cookie: "__Host-play_session=ok" }]);
  });

  it("fails on any other refusal, or a login without the session cookie, instead of writing a short sessions file", async () => {
    const base = { playOrigin: "https://play.example.test", tokens: ["t0"], concurrency: 1 };
    await expect(loginAll({ ...base, fetch: () => Promise.resolve(answer(400)) })).rejects.toThrow(/HTTP 400/);
    await expect(loginAll({ ...base, fetch: () => Promise.resolve(answer(200, ["other=1"])) })).rejects.toThrow(/no __Host-play_session cookie/);
  });
});
