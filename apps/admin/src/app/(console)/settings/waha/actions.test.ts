// The delete actions of Settings, WhatsApp (WAHA) are the Owner's alone: Staff are refused (403 from requireAdmin with the real policy), a
// cross-site POST is refused by the Origin check before the session is even read, and none of those reaches the database code. For the Owner:
// the redirect to ?deleted= after a delete, the refusal of the database code shown as the form's message (not a 500), and an unexpected form field refused.
// Next.js, the runtime and the session are mocked; the policy and the access decision are the real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSession } from "../../../../lib/auth/session.ts";

const ORIGIN = "https://admin.example.test"; // reserved TLD, test value only

const state = vi.hoisted((): { headers: Headers; session: AdminSession } => ({
  headers: new Headers(),
  session: { status: "active", admin: { userId: "u1", sessionId: "s1", role: "owner", displayName: "O" } },
}));

class Interrupt extends Error {}

vi.mock("next/navigation", () => ({
  forbidden: () => {
    throw new Interrupt("NEXT_HTTP_ERROR_FALLBACK;403");
  },
  redirect: (to: string) => {
    throw new Interrupt(`NEXT_REDIRECT;${to}`);
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Interrupt) throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("../../../../lib/next/runtime.ts", () => ({ getRuntime: () => Promise.resolve({ config: { origin: ORIGIN }, sql: {}, settings: {} }) }));
vi.mock("../../../../lib/next/request.ts", () => ({ requestInfo: () => Promise.resolve({ headers: state.headers, ip: "198.51.100.7" }) }));
vi.mock("../../../../lib/next/require-admin.ts", async () => {
  const { decide } = await import("../../../../lib/access.ts");
  const { forbidden, redirect } = await import("next/navigation");
  return {
    requireAdmin: (options: Parameters<typeof decide>[1]) => {
      const decision = decide(state.session, options);
      if (decision.kind === "redirect") redirect(decision.to);
      if (decision.kind === "forbidden") forbidden();
      return Promise.resolve(decision.kind === "allow" ? decision.admin : undefined);
    },
  };
});
const db = vi.hoisted(() => ({ deleteWahaServer: vi.fn(), deleteWahaSession: vi.fn() }));
vi.mock("../../../../lib/settings/waha.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }));

const { deleteWahaServerAction, deleteWahaSessionAction } = await import("./actions.ts");
const { InvalidInput } = await import("../../../../lib/settings/fields.ts");

const SERVER = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const SESSION = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const calls = () =>
  [
    ["delete server", () => deleteWahaServerAction({ status: "idle" }, form({ serverId: SERVER }))],
    ["delete session", () => deleteWahaSessionAction({ status: "idle" }, form({ sessionId: SESSION }))],
  ] as const;

beforeEach(() => {
  state.headers = new Headers({ origin: ORIGIN });
  state.session = { status: "active", admin: { userId: "u1", sessionId: "s1", role: "owner", displayName: "O" } };
  db.deleteWahaServer.mockResolvedValue(undefined);
  db.deleteWahaSession.mockResolvedValue(undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("the WAHA delete actions", () => {
  it.each(calls())("refuse Staff with 403 before any database call (%s)", async (_name, call) => {
    state.session = { status: "active", admin: { userId: "u2", sessionId: "s2", role: "staff", displayName: "S" } };
    await expect(call()).rejects.toThrow(/403/);
    expect(db.deleteWahaServer).not.toHaveBeenCalled();
    expect(db.deleteWahaSession).not.toHaveBeenCalled();
  });

  it.each(calls())("refuse a cross-site or Origin-less POST before the session (%s)", async (_name, call) => {
    for (const origin of [null, "https://evil.example.test", "null"]) {
      state.headers = origin === null ? new Headers() : new Headers({ origin });
      await expect(call()).rejects.toThrow(Interrupt);
    }
    expect(db.deleteWahaServer).not.toHaveBeenCalled();
    expect(db.deleteWahaSession).not.toHaveBeenCalled();
  });

  it.each(calls())("send a signed-out browser to the login page (%s)", async (_name, call) => {
    state.session = { status: "anonymous" };
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT;\/login/);
    expect(db.deleteWahaServer).not.toHaveBeenCalled();
    expect(db.deleteWahaSession).not.toHaveBeenCalled();
  });

  it("delete for the Owner, passing only the id that was submitted, then send the browser to the page with a fixed ?deleted= (the card is gone, so the page says it)", async () => {
    await expect(deleteWahaServerAction({ status: "idle" }, form({ serverId: SERVER }))).rejects.toThrow("NEXT_REDIRECT;/settings/waha?deleted=server");
    expect(db.deleteWahaServer).toHaveBeenCalledWith(expect.anything(), SERVER);
    await expect(deleteWahaSessionAction({ status: "idle" }, form({ sessionId: SESSION }))).rejects.toThrow("NEXT_REDIRECT;/settings/waha?deleted=session");
    expect(db.deleteWahaSession).toHaveBeenCalledWith(expect.anything(), SESSION);
  });

  it("show a refusal of the database code as the form's message, not as an error page", async () => {
    db.deleteWahaServer.mockRejectedValue(new InvalidInput("This server has message history, so it cannot be deleted."));
    expect(await deleteWahaServerAction({ status: "idle" }, form({ serverId: SERVER }))).toMatchObject({ status: "error", error: "This server has message history, so it cannot be deleted." });
    db.deleteWahaSession.mockRejectedValue(new InvalidInput("Untick Active and save before deleting."));
    expect(await deleteWahaSessionAction({ status: "idle" }, form({ sessionId: SESSION }))).toMatchObject({ status: "error", error: "Untick Active and save before deleting." });
  });

  it("refuse an unexpected form field, and a malformed id, before the database code", async () => {
    expect(await deleteWahaServerAction({ status: "idle" }, form({ serverId: SERVER, baseUrl: "https://x.example.test/" }))).toMatchObject({ status: "error" });
    expect(await deleteWahaSessionAction({ status: "idle" }, form({ sessionId: SESSION, serverId: SERVER }))).toMatchObject({ status: "error" });
    expect(await deleteWahaServerAction({ status: "idle" }, form({ serverId: "not-an-id" }))).toMatchObject({ status: "error" });
    expect(db.deleteWahaServer).not.toHaveBeenCalled();
    expect(db.deleteWahaSession).not.toHaveBeenCalled();
  });
});
