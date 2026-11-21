// Per-player unlock schedule (spec AC-Q4/AC-Q5, plan M2.4). Computed on read, never stored.
//
// Days are calendar days in WIB (Asia/Jakarta, UTC+7, no DST): a WIB day starts at 00:00 WIB,
// which is 17:00:00.000 UTC of the previous UTC day.
//
// Let S = set count, p = WIB day of the player's first paid order, D_end = the last day of the
// grace period, A = number of days from p to D_end inclusive, i = WIB day of `now` minus p.
//   - Set 1 unlocks at the payment instant (day 0).
//   - A >= S: one more set every day at 00:00 WIB, cumulative min(S, i + 1).
//   - A = 1:  all S sets on day 0.
//   - else:   cumulative 1 + floor(i * (S - 1) / (A - 1)) for i = 0 .. A - 1, so set S unlocks
//             exactly on D_end and never earlier.
//   - Result = max(formula, attempted, floor): a player never loses a set they already started,
//     nor one they were already shown as unlocked.
//
// The floor (caller contract): an extend-only reschedule (plan §10 item 10: more grace days)
// makes A larger, so the formula alone can drop below what the player already saw (buyer on
// 06-30 with 15 sets on 07-05; grace 30 -> 60 gives 8). Callers must persist the highest count
// they have shown (or the count at the moment of the reschedule) per player and program, and
// pass it as `floor` on every read.
//
// D_end = (WIB day of the last instant sales are open) + graceDays. Sales close AT `salesEnd`
// (programs.sales_end_at), so the last open instant is salesEnd - 1 ms. This gives the same
// D_end whether sales_end_at is stored as 23:59:59.999 WIB of the last sales day or as 00:00
// WIB of the next day. The admin program form (M5) should store it as (last sales day + 1)
// 00:00 WIB.

export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface UnlockSchedule {
  /** programs.sales_end_at: sales are closed from this instant on. */
  readonly salesEnd: Date;
  /** programs.grace_days (catch-up only, no sales). */
  readonly graceDays: number;
  /** S: number of sets in the program. */
  readonly setCount: number;
  /** player_programs.first_paid_at. */
  readonly firstPaidAt: Date;
}

export interface UnlockInput extends UnlockSchedule {
  readonly now: Date;
  /** Sets this player has already started (set_attempts rows) in this program. */
  readonly attempted: number;
  /** Highest count previously shown or persisted for this player (see the floor contract). */
  readonly floor?: number;
}

function assertDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/** WIB calendar day number (days since 1970-01-01 WIB) of an instant. */
export function wibDay(at: Date): number {
  assertDate(at, "at");
  return Math.floor((at.getTime() + WIB_OFFSET_MS) / DAY_MS);
}

/** The instant 00:00:00.000 WIB starts the given WIB day. */
export function wibDayStart(day: number): Date {
  if (!Number.isSafeInteger(day)) throw new RangeError("day must be a safe integer");
  return new Date(day * DAY_MS - WIB_OFFSET_MS);
}

/** D_end: the WIB day number of the last grace day. */
export function lastPlayDay(salesEnd: Date, graceDays: number): number {
  assertDate(salesEnd, "salesEnd");
  assertCount(graceDays, "graceDays");
  return wibDay(new Date(salesEnd.getTime() - 1)) + graceDays;
}

/**
 * A: days from the first-paid WIB day to D_end inclusive. Clamped to at least 1: a payment
 * settled on or after D_end (late settlement) unlocks every set at once.
 */
export function scheduleDays(schedule: UnlockSchedule): number {
  assertDate(schedule.firstPaidAt, "firstPaidAt");
  return Math.max(1, lastPlayDay(schedule.salesEnd, schedule.graceDays) - wibDay(schedule.firstPaidAt) + 1);
}

/** The spec formula: cumulative sets unlocked on day index i (0 = first-paid day). */
export function cumulativeUnlocked(dayIndex: number, days: number, setCount: number): number {
  if (!Number.isSafeInteger(dayIndex)) throw new RangeError("dayIndex must be a safe integer");
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("days must be a positive safe integer");
  assertCount(setCount, "setCount");
  if (setCount === 0 || dayIndex < 0) return 0;
  if (days >= setCount) return Math.min(setCount, dayIndex + 1);
  if (days === 1 || dayIndex >= days - 1) return setCount;
  return 1 + Math.floor((dayIndex * (setCount - 1)) / (days - 1));
}

function formulaAt(schedule: UnlockSchedule, at: Date): number {
  // Before the payment instant nothing is unlocked (set 1 unlocks "immediately on payment").
  if (at.getTime() < schedule.firstPaidAt.getTime()) return 0;
  return cumulativeUnlocked(wibDay(at) - wibDay(schedule.firstPaidAt), scheduleDays(schedule), schedule.setCount);
}

function validate(input: UnlockSchedule & { readonly now: Date }): void {
  assertDate(input.now, "now");
  assertDate(input.firstPaidAt, "firstPaidAt");
  assertDate(input.salesEnd, "salesEnd");
  assertCount(input.graceDays, "graceDays");
  assertCount(input.setCount, "setCount");
}

/** max(attempted, floor), each validated as 0..S. */
function lowerBound(input: { readonly setCount: number; readonly attempted?: number; readonly floor?: number }): number {
  let bound = 0;
  for (const [name, value] of [
    ["attempted", input.attempted],
    ["floor", input.floor],
  ] as const) {
    if (value === undefined) continue;
    assertCount(value, name);
    if (value > input.setCount) throw new RangeError(`${name} cannot exceed setCount`);
    bound = Math.max(bound, value);
  }
  return bound;
}

/** Number of sets (by position, 1..S) unlocked for the player at `now`. */
export function unlockedCount(input: UnlockInput): number {
  validate(input);
  // Required here (lowerBound treats it as optional for nextUnlockAt): reject undefined at runtime.
  assertCount(input.attempted, "attempted");
  return Math.max(formulaAt(input, input.now), lowerBound(input));
}

/**
 * When the formula first unlocks set number `rank` (1..S, by position): the payment instant for
 * the sets of day 0, else 00:00 WIB of the first day whose cumulative count reaches `rank`. The
 * trivia grid shows it on a locked tile (US-027). attempted and the floor can only unlock a set
 * earlier, so for a set still locked today this is exactly when it opens.
 */
export function setUnlocksAt(schedule: UnlockSchedule, rank: number): Date {
  assertDate(schedule.firstPaidAt, "firstPaidAt");
  assertCount(schedule.setCount, "setCount");
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > schedule.setCount) throw new RangeError("rank must be 1..setCount");
  const days = scheduleDays(schedule);
  let dayIndex = 0;
  // Terminates: the formula is S from day index A - 1 on, and rank <= S.
  while (cumulativeUnlocked(dayIndex, days, schedule.setCount) < rank) dayIndex++;
  return dayIndex === 0 ? schedule.firstPaidAt : wibDayStart(wibDay(schedule.firstPaidAt) + dayIndex);
}

/**
 * The next instant the displayed count max(formula, attempted, floor) grows (for the
 * countdown), or null when all sets are unlocked.
 */
export function nextUnlockAt(
  input: UnlockSchedule & { readonly now: Date; readonly attempted?: number; readonly floor?: number },
): Date | null {
  validate(input);
  const current = Math.max(formulaAt(input, input.now), lowerBound(input));
  if (current >= input.setCount) return null;
  if (input.now.getTime() < input.firstPaidAt.getTime() && formulaAt(input, input.firstPaidAt) > current) {
    return input.firstPaidAt;
  }
  const start = wibDay(input.firstPaidAt);
  const days = scheduleDays(input);
  // Terminates: the formula is S from day index A - 1 on, and current < S.
  let day = Math.max(wibDay(input.now), start) + 1;
  while (cumulativeUnlocked(day - start, days, input.setCount) <= current) day++;
  return wibDayStart(day);
}
