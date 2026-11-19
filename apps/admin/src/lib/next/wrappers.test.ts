// The server action and route handler wrappers on their own (code review US-016 CM4): their Origin
// check must refuse before anything else runs, even if the proxy were skipped, and their error
// handling must never let a driver detail through. Next.js, the runtime and the session are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://admin.example.test"; // reserved TLD, test value only
const EMAIL = "owner@example.test";

interface MockState {
  headers: Headers;
  session: unknown;
  requireAdminCalls: number;
}
const state = vi.hoisted((): MockState => ({
  headers: new Headers(),
  session: { status: "active", admin: { userId: "u1", sessionId: "s1", role: "owner", displayName: "O" } },
  requireAdminCalls: 0,
}));

class Interrupt extends Error {}

vi.mock("next/navigation", () => ({
  forbidden: () => {
    throw new Interrupt("NEXT_HTTP_ERROR_FALLBACK;403");
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Interrupt) throw error;
  },
}));
vi.mock("./runtime.ts", () => ({ getRuntime: () => Promise.resolve({ config: { origin: ORIGIN } }) }));
vi.mock("./request.ts", () => ({ requestInfo: () => Promise.resolve({ headers: state.headers, ip: "198.51.100.7" }) }));
vi.mock("./require-admin.ts", () => ({
  requireAdmin: () => {
    state.requireAdminCalls += 1;
    return Promise.resolve({ userId: "u1", sessionId: "s1", role: "owner", displayName: "O" });
  },
}));
vi.mock("../auth/session.ts", () => ({ loadAdminSession: () => Promise.resolve(state.session) }));

const { adminAction, authAction, REQUEST_FAILED } = await import("./actions.ts");
const { adminRoute } = await import("./route.ts");
const { currentMutationScope } = await import("../audit.ts");

let stderr: string[] = [];
beforeEach(() => {
  state.headers = new Headers();
  state.requireAdminCalls = 0;
  state.session = { status: "active", admin: { userId: "u1", sessionId: "s1", role: "owner", displayName: "O" } };
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const driverError = () => Object.assign(new Error(`insert failed: Failing row contains (${EMAIL})`), { code: "23514", detail: `Failing row contains (${EMAIL}, token-AbC123xyz987QWE)` });

describe("adminAction / authAction", () => {
  it.each([null, "null", "https://evil.example.test", `${ORIGIN}/`, "http://admin.example.test"])("refuses Origin %s before the session check or the body", async (origin) => {
    if (origin !== null) state.headers.set("origin", origin);
    const body = vi.fn(() => Promise.resolve("done"));
    await expect(adminAction({ permission: "dashboard.view" }, body)()).rejects.toThrow(Interrupt);
    await expect(authAction(body)()).rejects.toThrow(Interrupt);
    expect(body).not.toHaveBeenCalled();
    expect(state.requireAdminCalls).toBe(0);
  });

  it("runs the body for the admin origin, in a mutation scope, after requireAdmin", async () => {
    state.headers.set("origin", ORIGIN);
    const seen: unknown[] = [];
    const result = await adminAction({ permission: "dashboard.view" }, (ctx, x: number) => {
      seen.push(ctx.admin.userId, currentMutationScope()?.actor, currentMutationScope()?.ip);
      return Promise.resolve(x * 2);
    })(21);
    expect(result).toBe(42);
    expect(seen).toEqual(["u1", { kind: "admin", userId: "u1" }, "198.51.100.7"]);
    expect(state.requireAdminCalls).toBe(1);
    expect(await authAction(() => Promise.resolve(currentMutationScope()?.actor))()).toEqual({ kind: "system" });
  });

  it("replaces any other error with a bare one and logs only type and code", async () => {
    state.headers.set("origin", ORIGIN);
    const failing = adminAction({ permission: "dashboard.view" }, () => Promise.reject(driverError()));
    const error = await failing().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(REQUEST_FAILED);
    expect(Object.keys(error as object)).toEqual([]);
    const log = stderr.join("");
    expect(log).toContain('"errorCode":"23514"');
    expect(log).not.toContain(EMAIL);
    expect(log).not.toContain("Failing row");
    expect(log).not.toContain("AbC123xyz987QWE");
  });

  it("lets Next.js control flow (redirect / forbidden) through unchanged", async () => {
    state.headers.set("origin", ORIGIN);
    await expect(adminAction({ permission: "dashboard.view" }, () => Promise.reject(new Interrupt("NEXT_REDIRECT")))()).rejects.toThrow(Interrupt);
  });
});

describe("adminRoute", () => {
  const post = (origin: string | null) =>
    new Request(`${ORIGIN}/auth/sign-out`, { method: "POST", headers: origin === null ? {} : { origin } });

  it.each([null, "null", "https://evil.example.test"])("refuses a POST with Origin %s with 403 before the session or the handler", async (origin) => {
    const handler = vi.fn(() => Promise.resolve(new Response("ok")));
    const response = await adminRoute({ allowUnenrolled: true }, handler)(post(origin));
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs a POST from the admin origin in a mutation scope, a GET without one", async () => {
    const scopes: unknown[] = [];
    const handler = () => {
      scopes.push(currentMutationScope()?.actor ?? null);
      return Promise.resolve(new Response("ok"));
    };
    expect((await adminRoute({ allowUnenrolled: true }, handler)(post(ORIGIN))).status).toBe(200);
    expect((await adminRoute({ permission: "dashboard.view" }, handler)(new Request(`${ORIGIN}/x`))).status).toBe(200);
    expect(scopes).toEqual([{ kind: "admin", userId: "u1" }, null]);
  });

  it("answers 401 without a session, or what onAnonymous returns; 403 without the permission", async () => {
    state.session = { status: "anonymous" };
    const handler = vi.fn(() => Promise.resolve(new Response("ok")));
    expect((await adminRoute({ allowUnenrolled: true }, handler)(post(ORIGIN))).status).toBe(401);
    const login = await adminRoute({ allowUnenrolled: true }, handler, { onAnonymous: () => new Response(null, { status: 303, headers: { location: "/login" } }) })(post(ORIGIN));
    expect(login.status).toBe(303);
    state.session = { status: "active", admin: { userId: "u2", sessionId: "s2", role: "staff", displayName: "S" } };
    expect((await adminRoute({ permission: "admin_user.manage" }, handler)(post(ORIGIN))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers a bare 500 for any other error and logs only type and code", async () => {
    const response = await adminRoute({ allowUnenrolled: true }, () => Promise.reject(driverError()))(post(ORIGIN));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("The request failed.\n");
    expect(stderr.join("")).not.toContain(EMAIL);
  });
});
