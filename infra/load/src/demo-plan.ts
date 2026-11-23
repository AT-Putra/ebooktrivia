// The plan of a demo run (README: "Demo data on staging"): who the fake buyers are, when each one paid, and how each one plays.
// Pure: no database, no clock of its own, no network. The same seed, program facts and `now` always give the same plan, which is what
// the unit tests pin. The database part (demo-lib.ts) turns it into orders and players; the simulator (demo-play.ts) plays it.
import { unlockedCount, wibDay, wibDayStart } from "@ebooktrivia/core";

/** A small seeded PRNG (mulberry32): a uniform number in [0, 1) per call. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST_NAMES = [
  "Budi", "Siti", "Agus", "Dewi", "Rudi", "Sri", "Eko", "Ani", "Hendra", "Rina", "Joko", "Yuni", "Andi", "Lestari", "Bambang", "Fitri",
  "Dian", "Wahyu", "Putri", "Fajar", "Maya", "Rizky", "Nur", "Tri", "Ayu", "Bagus", "Indah", "Irfan", "Wulan", "Doni", "Citra", "Hadi",
  "Linda", "Arif", "Mega", "Yusuf", "Ratna", "Imam", "Sari", "Teguh",
] as const;
const LAST_NAMES = [
  "Santoso", "Wijaya", "Saputra", "Hidayat", "Kurniawan", "Pratama", "Setiawan", "Rahayu", "Nugroho", "Wibowo", "Susanto", "Lestari", "Hakim",
  "Permata", "Utami", "Firmansyah", "Gunawan", "Maulana", "Siregar", "Nasution", "Simanjuntak", "Hutapea", "Lubis", "Harahap", "Purnomo",
  "Cahyono", "Ramadhan", "Anggraini", "Suryani", "Prasetyo", "Halim", "Wardhana", "Kusuma", "Febrianti", "Mulyadi", "Effendi", "Marpaung",
  "Sutanto", "Damanik", "Syahputra",
] as const;

/** The payment methods the fake payments carry, with their weights (Midtrans payment_type values the fee table maps). */
const PAYMENT_TYPES = [
  ["qris", 45],
  ["gopay", 20],
  ["bank_transfer", 20],
  ["shopeepay", 10],
  ["credit_card", 5],
] as const;
export type DemoPaymentType = (typeof PAYMENT_TYPES)[number][0];

export const DEMO_MIN_BUYERS = 1;
export const DEMO_MAX_BUYERS = 200;
/** A buyer paid at least this long ago, so that set 1 (open at the payment instant) is open when the simulator starts. */
export const DEMO_PAID_MARGIN_MS = 15 * 60_000;
/** The sales window up to now must be at least this long for the dates to spread. */
export const DEMO_MIN_WINDOW_MS = 60 * 60_000;

/** One fake buyer's plan (snake_case: this object goes into the output file as it is). */
export interface BuyerPlan {
  /** 1-based, in paid order: buyer 1 paid first. */
  readonly index: number;
  readonly name: string;
  readonly paid_at: Date;
  readonly payment_type: DemoPaymentType;
  /** Sets open for the buyer at `now` (core unlockedCount, no attempts yet). */
  readonly unlocked_sets: number;
  /** How many of them are played: sets 1 to this number, in order. From 40 % of the unlocked sets (at least one) to all. */
  readonly sets_to_play: number;
  /** The chance that an answer is the correct one, 0.50 to 0.95. */
  readonly skill: number;
  readonly think_min_ms: number;
  readonly think_max_ms: number;
  /** The chance that a question is left to run out its timer, 0 to 0.03. */
  readonly timeout_rate: number;
  /** The last planned set is left half played: the buyer stops after `abandon_fraction` of its questions. */
  readonly abandon_last_set: boolean;
  readonly abandon_fraction: number;
  /** Seeds the simulator's per-question draws, so a rerun of one file plays the same way. */
  readonly play_seed: number;
}

/** The part of a buyer's plan the simulator plays. */
export type PlayPlan = Pick<BuyerPlan, "sets_to_play" | "skill" | "think_min_ms" | "think_max_ms" | "timeout_rate" | "abandon_last_set" | "abandon_fraction" | "play_seed">;

/**
 * What `seed.ts demo` writes and demo-play.ts reads. It holds one-time login links (live for 72 hours) and the id of the correct option
 * of every question of the program (the simulator needs them to answer at a chosen skill): it stays on the operator's machine and is
 * deleted after the run. No name, e-mail or phone number is in it.
 */
export interface DemoFile {
  readonly kind: "demo";
  readonly run_id: string;
  readonly seed: number;
  readonly planned_at: string;
  readonly program_id: string;
  readonly program_slug: string;
  readonly set_ids: string[];
  readonly questions_per_set: number[];
  readonly correct_option_ids: string[];
  readonly buyers: { readonly index: number; readonly label: string; readonly token: string; readonly plan: PlayPlan }[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const isNumbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isFinite(v));
const PLAN_NUMBERS = ["sets_to_play", "skill", "think_min_ms", "think_max_ms", "timeout_rate", "abandon_fraction", "play_seed"] as const;

/** Reads a demo file, refusing anything that is not one (a links.json of `seed.ts trivia`, a truncated file). */
export function parseDemoFile(text: string): DemoFile {
  const doc: unknown = JSON.parse(text);
  if (!isObject(doc) || doc["kind"] !== "demo") throw new Error('this is not a demo file (it has no "kind": "demo"): make it with `seed.ts demo`');
  const { run_id: runId, program_id: programId, program_slug: slug, set_ids: setIds, questions_per_set: questions, correct_option_ids: correct, buyers } = doc;
  if (typeof runId !== "string" || typeof programId !== "string" || typeof slug !== "string" || typeof doc["seed"] !== "number" || typeof doc["planned_at"] !== "string") {
    throw new Error("the demo file lacks run_id, seed, planned_at, program_id or program_slug");
  }
  if (!isStrings(setIds) || !isNumbers(questions) || !isStrings(correct) || !Array.isArray(buyers)) throw new Error("the demo file lacks set_ids, questions_per_set, correct_option_ids or buyers");
  for (const buyer of buyers as unknown[]) {
    const plan = isObject(buyer) ? buyer["plan"] : undefined;
    if (!isObject(buyer) || typeof buyer["token"] !== "string" || typeof buyer["label"] !== "string" || typeof buyer["index"] !== "number" || !isObject(plan)) throw new Error("a buyer of the demo file lacks its index, label, token or plan");
    for (const key of PLAN_NUMBERS) if (typeof plan[key] !== "number" || !Number.isFinite(plan[key])) throw new Error(`a buyer's plan lacks a number for ${key}`);
    if (typeof plan["abandon_last_set"] !== "boolean") throw new Error("a buyer's plan lacks abandon_last_set");
  }
  return doc as unknown as DemoFile;
}

export interface PlanInput {
  readonly seed: number;
  readonly buyers: number;
  readonly sales_start_at: Date;
  readonly sales_end_at: Date;
  readonly grace_days: number;
  readonly set_count: number;
  readonly now: Date;
}

/** The last instant a buyer may have paid: a margin before now, and never at or after the end of sales. */
export const paidWindowEnd = (salesEnd: Date, now: Date): Date => new Date(Math.min(salesEnd.getTime(), now.getTime() - DEMO_PAID_MARGIN_MS));

/** Why a paid date is refused ("" when it is inside the sales window up to now): the one rule the plan and the seeder both apply. */
export function paidDateProblem(paidAt: Date, salesStart: Date, salesEnd: Date, now: Date): string {
  const end = paidWindowEnd(salesEnd, now);
  if (paidAt.getTime() < salesStart.getTime() || paidAt.getTime() >= end.getTime()) {
    return `paid date ${paidAt.toISOString()} is outside the sales window ${salesStart.toISOString()} to ${end.toISOString()}`;
  }
  return "";
}

/** What `seed.ts demo` needs to know about the program it fills (read from the database by demo-lib.ts). */
export interface DemoProgramFacts {
  readonly slug: string;
  readonly status: string;
  readonly productActive: boolean;
  readonly salesStartAt: Date;
  readonly salesEndAt: Date;
  readonly graceDays: number;
  readonly lockedAt: Date | null;
  readonly setCount: number;
  /** Sets without a question: play refuses them (ET143), so a buyer who unlocked one could not play it. */
  readonly emptySets: number;
  readonly activeLandingPages: number;
}

/** The end of the grace period (sales end plus grace days): the worker writes the results snapshot and the winners by itself shortly after it. */
export const graceEnd = (salesEnd: Date, graceDays: number): Date => new Date(salesEnd.getTime() + graceDays * 24 * 60 * 60_000);

/** A demo run needs at least this long before the grace end, to be cleaned up in time. */
export const DEMO_MIN_GRACE_LEAD_MS = 2 * 24 * 60 * 60_000;

/**
 * Why a program is not a fit for demo buyers (empty = fine): it must be published and on a window that has begun, with sets that can
 * be played now, a landing page to hang the orders on, and a grace end at least 2 days away. After the grace end the worker's
 * endGracePeriods writes the results snapshot and the winners by itself; both are immutable, so cleanup could no longer remove the demo
 * buyers. And, because the first PAID order locks a program for good (triggers.sql programs_field_lock: product, slug and sales start can
 * no longer change, sets can no longer be added, removed or reordered, and locked_at is never cleared, not even by deleting the orders),
 * the program must either be locked already or be locked on purpose (--accept-program-lock).
 */
export function checkDemoProgram(program: DemoProgramFacts, now: Date, acceptProgramLock: boolean): string[] {
  const problems: string[] = [];
  if (program.status !== "published") problems.push(`program ${program.slug} is ${program.status}, not published`);
  if (!program.productActive) problems.push("the program's product is not active");
  if (paidWindowEnd(program.salesEndAt, now).getTime() - program.salesStartAt.getTime() < DEMO_MIN_WINDOW_MS) {
    problems.push(`the sales window up to now is shorter than an hour (sales start ${program.salesStartAt.toISOString()}): move the program's first sales day back BEFORE seeding, a locked program cannot be edited`);
  }
  const end = graceEnd(program.salesEndAt, program.graceDays);
  if (end.getTime() - now.getTime() < DEMO_MIN_GRACE_LEAD_MS) {
    problems.push(
      `the grace period of the program ends ${end.toISOString()}, less than 2 days from now: after it the worker writes the results snapshot and the winners by itself (immutable), and the demo buyers could no longer be removed. Use a program whose grace end is further away`,
    );
  }
  if (program.setCount === 0) problems.push("the program has no trivia set");
  if (program.emptySets > 0) problems.push(`${String(program.emptySets)} set(s) of the program have no question`);
  if (program.activeLandingPages === 0) problems.push("the program has no active landing page for the orders to belong to");
  if (program.lockedAt === null && !acceptProgramLock) {
    problems.push("the program has no paid order yet, and the first one locks it for good (sets, product, slug and sales start can no longer change, even after the demo is cleaned up): pass --accept-program-lock to go on");
  }
  return problems;
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

function paidDates(rng: () => number, buyers: number, start: Date, end: Date): Date[] {
  const span = end.getTime() - start.getTime();
  const dates: Date[] = [];
  for (let i = 0; i < buyers; i++) {
    // Stratified over the window, then bent toward the start: sales are heavier in the first days.
    const fraction = ((i + rng()) / buyers) ** 1.3;
    const exact = new Date(Math.min(start.getTime() + Math.floor(fraction * span), end.getTime() - 1));
    // A believable WIB time of day (07:00 to 22:59) on that day, when it still falls inside the window.
    const minute = 7 * 60 + Math.floor(rng() * 16 * 60);
    const shifted = new Date(wibDayStart(wibDay(exact)).getTime() + minute * 60_000 + Math.floor(rng() * 60_000));
    dates.push(shifted.getTime() >= start.getTime() && shifted.getTime() < end.getTime() ? shifted : exact);
  }
  return dates.sort((a, b) => a.getTime() - b.getTime());
}

function names(rng: () => number, buyers: number): string[] {
  const used = new Set<string>();
  while (used.size < buyers) {
    const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)] ?? "Budi";
    const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)] ?? "Santoso";
    used.add(`${first} ${last}`);
  }
  return [...used];
}

function paymentType(roll: number): DemoPaymentType {
  let rest = roll * PAYMENT_TYPES.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [type, weight] of PAYMENT_TYPES) {
    if (rest < weight) return type;
    rest -= weight;
  }
  return "qris";
}

/** The plan of every buyer, in paid order. Throws when the window cannot hold the dates (the seeder checks every date again against the database's own values). */
export function planDemoBuyers(input: PlanInput): BuyerPlan[] {
  if (!Number.isInteger(input.buyers) || input.buyers < DEMO_MIN_BUYERS || input.buyers > DEMO_MAX_BUYERS) {
    throw new RangeError(`buyers must be a whole number from ${String(DEMO_MIN_BUYERS)} to ${String(DEMO_MAX_BUYERS)}`);
  }
  const end = paidWindowEnd(input.sales_end_at, input.now);
  if (end.getTime() - input.sales_start_at.getTime() < DEMO_MIN_WINDOW_MS) {
    throw new RangeError(`the sales window up to now (${input.sales_start_at.toISOString()} to ${end.toISOString()}) is shorter than an hour`);
  }
  const rng = mulberry32(input.seed);
  const dates = paidDates(rng, input.buyers, input.sales_start_at, end);
  const fullNames = names(rng, input.buyers);
  return dates.map((paidAt, i): BuyerPlan => {
    const problem = paidDateProblem(paidAt, input.sales_start_at, input.sales_end_at, input.now);
    if (problem !== "") throw new RangeError(problem);
    const unlocked = unlockedCount({ salesEnd: input.sales_end_at, graceDays: input.grace_days, setCount: input.set_count, firstPaidAt: paidAt, now: input.now, attempted: 0 });
    if (unlocked < 1) throw new RangeError("a buyer would have no set open (the program has no set, or its play period has ended)");
    // Draws in a fixed order per buyer, so one buyer's plan never depends on another's choices.
    const skill = round(0.5 + 0.45 * ((rng() + rng()) / 2), 3);
    const coverage = 0.4 + 0.6 * rng();
    const thinkMin = 2000 + Math.floor(rng() * 3000);
    const thinkMax = Math.min(12_000, thinkMin + 3000 + Math.floor(rng() * 4000));
    const timeoutRoll = rng();
    const timeoutAmount = rng();
    const timeoutRate = timeoutRoll < 0.4 ? 0 : round(0.005 + timeoutAmount * 0.025, 4);
    const abandon = rng() < 0.2;
    const abandonFraction = round(0.3 + rng() * 0.4, 2);
    const playSeed = Math.floor(rng() * 4_294_967_296);
    const method = paymentType(rng());
    return {
      index: i + 1,
      name: fullNames[i] ?? `Pembeli ${String(i + 1)}`,
      paid_at: paidAt,
      payment_type: method,
      unlocked_sets: unlocked,
      sets_to_play: Math.min(unlocked, Math.max(1, Math.ceil(unlocked * coverage))),
      skill,
      think_min_ms: thinkMin,
      think_max_ms: thinkMax,
      timeout_rate: timeoutRate,
      abandon_last_set: abandon,
      abandon_fraction: abandonFraction,
      play_seed: playSeed,
    };
  });
}

/** `demo-<run>-<NN>@example.com`: example.com is reserved (RFC 2606), so no such address reaches a mailbox. NN has as many digits as the largest index needs, at least two. */
export function demoEmail(runId: string, index: number, buyers: number): string {
  return `${demoLabel(runId, index, buyers)}@example.com`;
}

/** `demo-<run>-<NN>`: the run's marker on a buyer (e-mail local part, payment reference). */
export function demoLabel(runId: string, index: number, buyers: number): string {
  return `demo-${runId}-${String(index).padStart(Math.max(2, String(buyers).length), "0")}`;
}

/** How many answers a buyer gives in a set it leaves half played: its share of the questions, at least one and never all of them (a set of one question cannot be left half). */
export const abandonAfter = (questions: number, fraction: number): number => (questions > 1 ? Math.min(questions - 1, Math.max(1, Math.ceil(fraction * questions))) : questions);

/** "45 s", "12 min" or "2 h 05 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 120) return `${String(Math.max(0, Math.round(seconds)))} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${String(minutes)} min` : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The size of a plan: sets, answers, and the seconds all of them take one after another at speed 1 (every answer at its average think time plus half a second of calls; timeouts not counted). */
export function estimateSeconds(plans: readonly PlayPlan[], questionsPerSet: readonly number[]): { readonly answers: number; readonly sets: number; readonly seconds: number } {
  let answers = 0;
  let sets = 0;
  let milliseconds = 0;
  for (const plan of plans) {
    for (let s = 0; s < plan.sets_to_play; s++) {
      const questions = questionsPerSet[s] ?? 0;
      const played = plan.abandon_last_set && s === plan.sets_to_play - 1 ? abandonAfter(questions, plan.abandon_fraction) : questions;
      answers += played;
      milliseconds += played * ((plan.think_min_ms + plan.think_max_ms) / 2 + 500);
      sets++;
    }
  }
  return { answers, sets, seconds: Math.round(milliseconds / 1000) };
}
