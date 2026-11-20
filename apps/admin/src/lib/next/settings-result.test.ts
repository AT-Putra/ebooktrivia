// The settings form result (code review US-018 F9): a role refused inside the change (Staff who
// loaded a trivia set before its first attempt) sees the reason in the form, not a 403 page, and
// nothing is revalidated; any other error still propagates.
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (path: string, scope?: string) => {
    revalidated.push(`${path}${scope === undefined ? "" : `:${scope}`}`);
  },
}));

const { saveResult } = await import("./settings-result.ts");
const { InvalidInput, NotAllowed } = await import("../settings/fields.ts");
const { STAFF_LOCKED } = await import("../settings/trivia.ts");

beforeEach(() => {
  revalidated.length = 0;
});

describe("saveResult", () => {
  it("returns the confirmation and revalidates the path (or the whole layout)", async () => {
    expect(await saveResult("/settings/x", () => Promise.resolve("Saved."))).toMatchObject({ status: "saved", message: "Saved." });
    expect(await saveResult("/settings/trivia", () => Promise.resolve("Saved."), "layout")).toMatchObject({ status: "saved" });
    expect(revalidated).toEqual(["/settings/x", "/settings/trivia:layout"]);
  });

  it("shows a NotAllowed refusal as the form's message, like InvalidInput, and revalidates nothing", async () => {
    expect(await saveResult("/settings/trivia", () => Promise.reject(new NotAllowed(STAFF_LOCKED)), "layout")).toMatchObject({ status: "error", error: STAFF_LOCKED });
    expect(await saveResult("/settings/trivia", () => Promise.reject(new InvalidInput("Nope.")))).toMatchObject({ status: "error", error: "Nope." });
    expect(revalidated).toEqual([]);
  });

  it("lets any other error propagate (adminAction logs it and answers with a bare error)", async () => {
    await expect(saveResult("/x", () => Promise.reject(new Error("driver detail")))).rejects.toThrow("driver detail");
  });
});
