// playRoute (US-026 review): `defer` is Next.js after(), so deferred work (the OTP issue, which decides who is
// eligible) has NOT run when the handler returns its answer; and the play routes alone answer 503 while the
// player login is not configured.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("../runtime.ts", () => ({ runtimeOrUnavailable: vi.fn() }));

const { after } = await import("next/server");
const { runtimeOrUnavailable } = await import("../runtime.ts");
const { playRoute } = await import("./route.ts");

const request = () => new Request("https://play.example.test/api/v1/play/auth/otp", { method: "POST" });

beforeEach(() => {
  vi.mocked(after).mockReset();
  vi.mocked(runtimeOrUnavailable).mockReset();
});

describe("playRoute", () => {
  it("hands deferred work to after(): it has not run when the handler returns, and runs when Next calls it", async () => {
    vi.mocked(runtimeOrUnavailable).mockResolvedValue({ play: { playOrigin: "https://play.example.test" } } as never);
    const ran: string[] = [];
    const route = playRoute("play.test", (deps) => {
      deps.defer(() => {
        ran.push("task");
        return Promise.resolve();
      });
      ran.push("answer");
      return Promise.resolve(new Response("ok"));
    });
    const response = await route(request());
    expect(await response.text()).toBe("ok");
    expect(ran).toEqual(["answer"]);
    expect(after).toHaveBeenCalledTimes(1);
    const task = vi.mocked(after).mock.calls[0]?.[0] as () => Promise<void>;
    await task();
    expect(ran).toEqual(["answer", "task"]);
  });

  it("answers 503 unavailable for the play routes while the player login is not configured", async () => {
    vi.mocked(runtimeOrUnavailable).mockResolvedValue({ play: null } as never);
    const handler = vi.fn();
    const response = await playRoute("play.test", handler)(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the runtime's own 503 through", async () => {
    vi.mocked(runtimeOrUnavailable).mockResolvedValue(new Response("down", { status: 503 }));
    const handler = vi.fn();
    expect((await playRoute("play.test", handler)(request())).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
