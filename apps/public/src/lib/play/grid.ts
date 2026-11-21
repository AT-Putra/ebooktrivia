// The trivia page's view of one program (US-027, AC-Q2): the grid states from core unlock.ts with the max rule
// (max(formula, attempted, floor); play_start_set checks the same in SQL), the next-unlock countdown, the phase
// of the banner. Pure: the page passes the database's clock.
import { graceEndAt, nextUnlockAt, setUnlocksAt, type UnlockSchedule, unlockedCount } from "@ebooktrivia/core";
import type { PageSet, ProgramPage } from "./trivia-data.ts";

export type TileState = "completed" | "in-progress" | "unlocked" | "locked";

export interface Tile {
  /** 1..S: the set's place in the program (positions may have gaps). */
  readonly n: number;
  readonly set: PageSet;
  readonly state: TileState;
  /** Locked tiles: when the schedule opens the set. */
  readonly unlocksAt: Date | null;
  /** The set to play next (the first one started or open). */
  readonly next: boolean;
}

export type Phase = "sales" | "grace" | "ended";

export interface ProgramView {
  readonly tiles: readonly Tile[];
  readonly unlocked: number;
  readonly done: number;
  /** When the next set opens (the countdown), null when every set is open or play has ended. */
  readonly nextUnlockAt: Date | null;
  readonly phase: Phase;
  /** When the phase ends (sales end, grace end), null once ended. */
  readonly phaseEndsAt: Date | null;
  /** No set can be started or served any more (after the grace end, or the program is no longer published). */
  readonly closed: boolean;
}

export function programView(page: Pick<ProgramPage, "status" | "salesEnd" | "graceDays" | "firstPaidAt" | "floor" | "now" | "sets">): ProgramView {
  const schedule: UnlockSchedule = { salesEnd: page.salesEnd, graceDays: page.graceDays, setCount: page.sets.length, firstPaidAt: page.firstPaidAt };
  const attempted = page.sets.filter((s) => s.attempt !== null).length;
  const floor = Math.min(page.floor, page.sets.length);
  const unlocked = unlockedCount({ ...schedule, now: page.now, attempted, floor });
  const graceEnd = graceEndAt(page.salesEnd, page.graceDays);
  const closed = page.status !== "published" || page.now.getTime() >= graceEnd.getTime();
  const phase: Phase = closed ? "ended" : page.now.getTime() < page.salesEnd.getTime() ? "sales" : "grace";
  const next = closed ? -1 : page.sets.findIndex((s, i) => s.attempt?.finished !== true && i < unlocked);
  const tiles = page.sets.map((set, i): Tile => {
    const state: TileState = set.attempt?.finished === true ? "completed" : set.attempt !== null ? "in-progress" : i < unlocked ? "unlocked" : "locked";
    return { n: i + 1, set, state, unlocksAt: state === "locked" ? setUnlocksAt(schedule, i + 1) : null, next: i === next };
  });
  return {
    tiles,
    unlocked,
    done: page.sets.filter((s) => s.attempt?.finished === true).length,
    nextUnlockAt: closed ? null : nextUnlockAt({ ...schedule, now: page.now, attempted, floor }),
    phase,
    phaseEndsAt: phase === "sales" ? page.salesEnd : phase === "grace" ? graceEnd : null,
    closed,
  };
}
