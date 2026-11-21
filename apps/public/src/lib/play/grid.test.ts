// The trivia page's grid and phases (US-027): core unlock.ts with the max rule, the next unlock, the closed state.
import { describe, expect, it } from "vitest";
import { programView } from "./grid.ts";
import type { PageSet, ProgramPage } from "./trivia-data.ts";

const wib = (date: string, time = "00:00:00.000"): Date => new Date(`${date}T${time}+07:00`);

const set = (position: number, attempt: PageSet["attempt"] = null): PageSet => ({
  id: `set-${String(position)}`,
  position: position * 10,
  title: `Set ${String(position)}`,
  questionCount: 2,
  maxScore: 20,
  attempt,
});

/** 10 sets; sales end 2027-01-11 00:00 WIB, no grace: a buyer on 01-01 gets one set a day (A = 10). */
function page(over: Partial<ProgramPage> = {}): ProgramPage {
  return {
    id: "p",
    slug: "juni-2026",
    name: "Program",
    status: "published",
    salesEnd: wib("2027-01-11"),
    graceDays: 0,
    firstPaidAt: wib("2027-01-01", "10:00:00.000"),
    floor: 0,
    now: wib("2027-01-03", "08:00:00.000"),
    sets: Array.from({ length: 10 }, (_, i) => set(i + 1)),
    tiers: [],
    winners: [],
    ...over,
  };
}

describe("programView", () => {
  it("opens one set a day: day 2 shows 3 open sets, the next at 00:00 WIB, dates on the locked tiles", () => {
    const view = programView(page());
    expect(view.unlocked).toBe(3);
    expect(view.tiles.map((t) => t.state)).toEqual(["unlocked", "unlocked", "unlocked", ...Array<string>(7).fill("locked")]);
    expect(view.tiles.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(view.nextUnlockAt).toEqual(wib("2027-01-04"));
    expect(view.tiles[3]?.unlocksAt).toEqual(wib("2027-01-04"));
    expect(view.tiles[9]?.unlocksAt).toEqual(wib("2027-01-10"));
    expect(view.tiles[0]?.unlocksAt).toBeNull();
    expect(view.tiles.filter((t) => t.next).map((t) => t.n)).toEqual([1]);
    expect(view).toMatchObject({ phase: "sales", phaseEndsAt: wib("2027-01-11"), closed: false, done: 0 });
  });

  it("marks completed and started sets, and the next set to play", () => {
    const sets = [set(1, { id: "a1", score: 10, finished: true }), set(2, { id: "a2", score: 0, finished: false }), ...Array.from({ length: 8 }, (_, i) => set(i + 3))];
    const view = programView(page({ sets }));
    expect(view.tiles.slice(0, 4).map((t) => t.state)).toEqual(["completed", "in-progress", "unlocked", "locked"]);
    expect(view.tiles.filter((t) => t.next).map((t) => t.n)).toEqual([2]);
    expect(view.done).toBe(1);
  });

  it("keeps the max rule: the floor and the started sets stay open after a reschedule", () => {
    // Grace extended to 60 days: the formula alone gives 3 on day 2 (one a day), the floor says 6 were shown.
    const view = programView(page({ graceDays: 60, floor: 6 }));
    expect(view.unlocked).toBe(6);
    expect(view.tiles[5]?.state).toBe("unlocked");
    expect(view.tiles[6]?.state).toBe("locked");
    expect(view.nextUnlockAt).toEqual(wib("2027-01-07"));
    const started = programView(page({ sets: [...Array.from({ length: 4 }, (_, i) => set(i + 1, { id: `a${String(i)}`, score: 0, finished: true })), ...Array.from({ length: 6 }, (_, i) => set(i + 5))] }));
    expect(started.unlocked).toBe(4);
    // A floor above the set count (sets cannot be removed once locked; defensive) is clamped.
    expect(programView(page({ floor: 99 })).unlocked).toBe(10);
  });

  it("shows the grace phase after the sales end, and closes play at the grace end or once the contest ended", () => {
    const grace = programView(page({ graceDays: 5, now: wib("2027-01-12", "09:00:00.000") }));
    expect(grace).toMatchObject({ phase: "grace", phaseEndsAt: wib("2027-01-16"), closed: false, unlocked: 10, nextUnlockAt: null });
    const ended = programView(page({ now: wib("2027-01-11", "00:00:01.000") }));
    expect(ended).toMatchObject({ phase: "ended", phaseEndsAt: null, closed: true, nextUnlockAt: null, unlocked: 10 });
    expect(ended.tiles.some((t) => t.next)).toBe(false);
    expect(programView(page({ status: "awaiting_confirmation" }))).toMatchObject({ closed: true, phase: "ended" });
  });

  it("reports no next unlock once every set is open", () => {
    expect(programView(page({ now: wib("2027-01-10", "12:00:00.000") }))).toMatchObject({ unlocked: 10, nextUnlockAt: null });
  });
});
