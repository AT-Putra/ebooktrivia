// US-033: every action of the review queue is refused server-side for Staff (403 from requireAdmin with the real policy) and for
// a cross-site POST (the Origin check, before the session is even read), and never reaches the database code. Next.js, the
// runtime and the session are mocked; the policy and the access decision are the real ones.
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
vi.mock("../../../../lib/next/runtime.ts", () => ({ getRuntime: () => Promise.resolve({ config: { origin: ORIGIN }, sql: {} }) }));
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
const db = vi.hoisted(() => ({ decideReview: vi.fn(), requestRequery: vi.fn(), revealBuyer: vi.fn() }));
vi.mock("../../../../lib/review/review.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }));

const { decideReviewAction, requeryReviewAction, revealBuyerAction } = await import("./actions.ts");

const ORDER = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const KEY = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const decisionForm = () => form({ id: ORDER, decision: "paid", confirm: "AbCdEf0123456789XYZ", reason: "Midtrans support confirmed the transfer arrived.", key: KEY });
const calls = () =>
  [
    ["decide", () => decideReviewAction({ status: "idle" }, decisionForm())],
    ["requery", () => requeryReviewAction({ status: "idle" }, form({ id: ORDER, key: KEY }))],
    ["reveal", () => revealBuyerAction({ status: "idle" }, form({ id: ORDER }))],
  ] as const;

beforeEach(() => {
  state.headers = new Headers({ origin: ORIGIN });
  state.session = { status: "active", admin: { userId: "u1", sessionId: "s1", role: "owner", displayName: "O" } };
  db.decideReview.mockResolvedValue({
    decision: "paid",
    replayed: false,
    eligible: true,
    deliveriesCreated: 0,
    deliveriesRevived: 1,
    mtCreated: 0,
    mtRevived: 2,
    reversalsCreated: 0,
    magicLinksRevoked: 0,
    winnersFlagged: 0,
    alertsResolved: 1,
    fulfilmentSkipped: false,
  });
  db.requestRequery.mockResolvedValue(true);
  db.revealBuyer.mockResolvedValue({ name: "Budi Santoso", phone: "+6281234567890", email: "budi@example.test" });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("the review queue's actions", () => {
  it.each(calls())("refuse Staff with 403 before any database call (%s)", async (_name, call) => {
    state.session = { status: "active", admin: { userId: "u2", sessionId: "s2", role: "staff", displayName: "S" } };
    await expect(call()).rejects.toThrow(/403/);
    expect(db.decideReview).not.toHaveBeenCalled();
    expect(db.requestRequery).not.toHaveBeenCalled();
    expect(db.revealBuyer).not.toHaveBeenCalled();
  });

  it.each(calls())("refuse a cross-site or Origin-less POST before the session (%s)", async (_name, call) => {
    for (const origin of [null, "https://evil.example.test", "null"]) {
      state.headers = origin === null ? new Headers() : new Headers({ origin });
      await expect(call()).rejects.toThrow(Interrupt);
    }
    expect(db.decideReview).not.toHaveBeenCalled();
    expect(db.requestRequery).not.toHaveBeenCalled();
    expect(db.revealBuyer).not.toHaveBeenCalled();
  });

  it.each(calls())("send a signed-out browser to the login page (%s)", async (_name, call) => {
    state.session = { status: "anonymous" };
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT;\/login/);
  });

  it("run for the Owner: the decision with the parsed form, the re-query, the audited reveal", async () => {
    expect(await decideReviewAction({ status: "idle" }, decisionForm())).toMatchObject({ status: "saved", message: expect.stringContaining("Marked paid") as unknown });
    expect(db.decideReview).toHaveBeenCalledWith({}, { orderId: ORDER, decision: "paid", confirm: "AbCdEf0123456789XYZ", reason: "Midtrans support confirmed the transfer arrived.", requestKey: KEY });
    expect(await requeryReviewAction({ status: "idle" }, form({ id: ORDER, key: KEY }))).toMatchObject({ status: "saved" });
    expect(await revealBuyerAction({ status: "idle" }, form({ id: ORDER }))).toMatchObject({ status: "shown", phone: "+6281234567890" });
  });

  it("refuse a tampered form (an unknown field, a bad decision) with a message, without the database", async () => {
    expect(await decideReviewAction({ status: "idle" }, form({ id: ORDER, decision: "refund", confirm: "x", reason: "Midtrans support confirmed it.", key: KEY }))).toMatchObject({ status: "error" });
    const extra = decisionForm();
    extra.set("to_status", "paid");
    expect(await decideReviewAction({ status: "idle" }, extra)).toMatchObject({ status: "error" });
    expect(await revealBuyerAction({ status: "idle" }, form({ id: "not-a-uuid" }))).toMatchObject({ status: "error" });
    expect(db.decideReview).not.toHaveBeenCalled();
    expect(db.revealBuyer).not.toHaveBeenCalled();
  });
});
