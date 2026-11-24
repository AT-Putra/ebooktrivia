import { describe, expect, it } from "vitest";
import { OPENER_NO_REPEAT, pickOpenerWording } from "./delivery-opener.ts";

describe("pickOpenerWording: no repeat of the last 3 wordings of a number (Owner decision 2026-11-24)", () => {
  const keys = ["delivery_opener_1", "delivery_opener_2", "delivery_opener_3", "delivery_opener_4", "delivery_opener_5"];
  /** A random source that answers the given draws in order (then 0). */
  const draw = (...answers: number[]) => {
    let i = 0;
    return () => answers[i++] ?? 0;
  };

  it("chooses uniformly among the wordings that are not among the last 3 used (newest first): the draw indexes the allowed ones in order", () => {
    // Recent 5, 4, 3 -> allowed 1, 2.
    const recent = ["delivery_opener_5", "delivery_opener_4", "delivery_opener_3"];
    expect(pickOpenerWording(keys, recent, () => 0)).toBe("delivery_opener_1");
    expect(pickOpenerWording(keys, recent, () => 0.49)).toBe("delivery_opener_1");
    expect(pickOpenerWording(keys, recent, () => 0.5)).toBe("delivery_opener_2");
    expect(pickOpenerWording(keys, recent, () => 0.999)).toBe("delivery_opener_2");
    // A draw of exactly 1 (a broken source) never runs off the list.
    expect(pickOpenerWording(keys, recent, () => 1)).toBe("delivery_opener_2");
  });

  it("only the last 3 openers count: the fourth newest wording is allowed again, and no history leaves every wording open", () => {
    const recent = ["delivery_opener_5", "delivery_opener_4", "delivery_opener_3", "delivery_opener_2"];
    expect(pickOpenerWording(keys, recent, draw(0.5))).toBe("delivery_opener_2");
    expect(pickOpenerWording(keys, [], draw(0.99))).toBe("delivery_opener_5");
    expect(pickOpenerWording(keys, [], draw(0))).toBe("delivery_opener_1");
  });

  it("a wording used twice in the window excludes only itself (it takes one place, not two)", () => {
    const recent = ["delivery_opener_1", "delivery_opener_1", "delivery_opener_2"];
    expect(pickOpenerWording(keys, recent, draw(0))).toBe("delivery_opener_3");
  });

  it("with fewer than 4 wordings it excludes as many of the newest as leaves at least one", () => {
    const three = keys.slice(0, 3);
    // 3 wordings, last 3 all different: the two newest are excluded, the oldest is the only choice.
    expect(pickOpenerWording(three, ["delivery_opener_3", "delivery_opener_2", "delivery_opener_1"], draw(0.9))).toBe("delivery_opener_1");
    expect(pickOpenerWording(three, ["delivery_opener_1", "delivery_opener_3", "delivery_opener_2"], draw(0))).toBe("delivery_opener_2");
    // 2 wordings: only the newest is excluded. 1 wording: it is always used.
    expect(pickOpenerWording(keys.slice(0, 2), ["delivery_opener_2", "delivery_opener_1"], draw(0))).toBe("delivery_opener_1");
    expect(pickOpenerWording(keys.slice(0, 1), ["delivery_opener_1", "delivery_opener_1", "delivery_opener_1"], draw(0.5))).toBe("delivery_opener_1");
  });

  it("a removed wording in the history takes its place in the window but excludes nothing, and no wording at all is undefined", () => {
    // 9 was removed: it still counts as one of the last 3, so only 4 and 3 exclude anything.
    expect(pickOpenerWording(keys, ["delivery_opener_9", "delivery_opener_4", "delivery_opener_3"], draw(0.99))).toBe("delivery_opener_5");
    expect(pickOpenerWording(keys, ["delivery_opener_9", "delivery_opener_4", "delivery_opener_3"], draw(0))).toBe("delivery_opener_1");
    // Three removed ones fill the window: the wording used just before them is allowed again.
    expect(pickOpenerWording(keys, ["delivery_opener_9", "delivery_opener_8", "delivery_opener_7", "delivery_opener_1"], draw(0))).toBe("delivery_opener_1");
    expect(pickOpenerWording([], ["delivery_opener_1"], draw(0))).toBeUndefined();
    expect(OPENER_NO_REPEAT).toBe(3);
  });

  it("over many openers a number never repeats within 3 and uses every wording", () => {
    // mulberry32: a small seeded generator, uniform in [0, 1).
    let state = 7;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const used: string[] = [];
    for (let i = 0; i < 300; i++) {
      const next = pickOpenerWording(keys, [...used].reverse().slice(0, 3), random);
      if (next === undefined) throw new Error("a wording exists");
      expect(used.slice(-3)).not.toContain(next);
      used.push(next);
    }
    expect(new Set(used).size).toBe(keys.length);
  });
});
