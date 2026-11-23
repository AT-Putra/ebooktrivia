import type { AssetId } from "./assets.ts";

export type SetState = "completed" | "unlocked" | "in-progress" | "locked";

export interface TriviaSet {
  n: number;
  art: AssetId;
  topic: "culture" | "geography" | "history" | "nature" | "science" | "sports";
  state: SetState;
  score?: number;
  /** Locked sets: text that follows "Terbuka" (relative or absolute). */
  unlock?: { kind: "countdown"; seconds: number } | { kind: "days"; n: number } | { kind: "date"; date: string };
  next?: boolean;
}

export interface LeaderRow {
  rank: number;
  name: string;
  score: number;
  seconds: number;
}

export interface Program {
  slug: string;
  name: string;
  done: number;
  total: number;
  prizes: { gold: number; silver: number; bronze: number };
  /** The quiz deadline (the grace end) and the time left to it. */
  quizEndsAt: Date;
  quizSeconds: number;
  profile: { name: string; score: number; seconds: number; rank: number; nextUnlockSeconds: number };
  leaderboard: LeaderRow[];
  me: LeaderRow;
  sets: TriviaSet[];
}

const TOPICS: { art: AssetId; topic: TriviaSet["topic"] }[] = [
  { art: "set-history", topic: "history" },
  { art: "set-science", topic: "science" },
  { art: "set-nature", topic: "nature" },
  { art: "set-geography", topic: "geography" },
  { art: "set-culture", topic: "culture" },
  { art: "set-sports", topic: "sports" },
];

function buildSets(states: Omit<TriviaSet, "art" | "topic">[]): TriviaSet[] {
  return states.map((s, i) => {
    const topic = TOPICS[i % TOPICS.length];
    if (topic === undefined) throw new Error("topics empty");
    return { ...topic, ...s };
  });
}

const NAMES = [
  "Ra** P*****",
  "Di** A*****",
  "Si** N*****",
  "Fa** H*****",
  "Yo** K*****",
  "Ma** L*****",
  "An** W*****",
  "Hi** S*****",
  "Ba** T*****",
  "Ni** R*****",
];

function buildBoard(base: number, step: number, baseSeconds: number): LeaderRow[] {
  return NAMES.map((name, i) => ({
    rank: i + 1,
    name,
    score: base - i * step,
    seconds: baseSeconds + i * 97,
  }));
}

export const PROGRAMS: Program[] = [
  {
    slug: "nusantara",
    name: "Trivia Nusantara Juara",
    done: 12,
    total: 90,
    prizes: { gold: 5_000_000, silver: 2_500_000, bronze: 1_000_000 },
    quizEndsAt: new Date("2027-03-22T00:00:00+07:00"),
    quizSeconds: 89 * 86_400 + 4 * 3600 + 18 * 60 + 22,
    profile: { name: "Bu** S***", score: 1240, seconds: 2538, rank: 47, nextUnlockSeconds: 3 * 3600 + 12 * 60 + 45 },
    leaderboard: buildBoard(3480, 110, 3185),
    me: { rank: 47, name: "Bu** S***", score: 1240, seconds: 2538 },
    sets: buildSets([
      { n: 1, state: "completed", score: 100 },
      { n: 2, state: "completed", score: 80 },
      { n: 3, state: "completed", score: 90 },
      { n: 4, state: "completed", score: 70 },
      { n: 5, state: "unlocked" },
      { n: 6, state: "in-progress" },
      { n: 7, state: "locked", next: true, unlock: { kind: "countdown", seconds: 3 * 3600 + 12 * 60 + 45 } },
      { n: 8, state: "locked", unlock: { kind: "days", n: 2 } },
      { n: 9, state: "locked", unlock: { kind: "days", n: 3 } },
      { n: 10, state: "locked", unlock: { kind: "date", date: "14 Mei" } },
    ]),
  },
  {
    slug: "sains",
    name: "Kuis Sains Ceria",
    done: 3,
    total: 30,
    prizes: { gold: 2_000_000, silver: 1_000_000, bronze: 500_000 },
    quizEndsAt: new Date("2027-04-12T00:00:00+07:00"),
    quizSeconds: 21 * 86_400 + 5 * 3600 + 5 * 60 + 30,
    profile: { name: "Bu** S***", score: 420, seconds: 905, rank: 112, nextUnlockSeconds: 7 * 3600 + 48 * 60 + 2 },
    leaderboard: buildBoard(1820, 60, 1450),
    me: { rank: 112, name: "Bu** S***", score: 420, seconds: 905 },
    sets: buildSets([
      { n: 1, state: "completed", score: 90 },
      { n: 2, state: "completed", score: 100 },
      { n: 3, state: "completed", score: 60 },
      { n: 4, state: "unlocked" },
      { n: 5, state: "locked", next: true, unlock: { kind: "countdown", seconds: 7 * 3600 + 48 * 60 + 2 } },
      { n: 6, state: "locked", unlock: { kind: "days", n: 2 } },
      { n: 7, state: "locked", unlock: { kind: "days", n: 3 } },
      { n: 8, state: "locked", unlock: { kind: "date", date: "21 Mei" } },
    ]),
  },
];

/** The mockup's prizes as the live page's tiers (one tier per place, real prize names, no uploaded pictures): the banner's prize list and the leaderboard's medals follow them. */
export function mockupTiers(program: Program): { rankFrom: number; rankTo: number; name: string; valueIdr: number; imageUrl: null }[] {
  return [
    { rankFrom: 1, rankTo: 1, name: "Saldo e-wallet", valueIdr: program.prizes.gold, imageUrl: null },
    { rankFrom: 2, rankTo: 2, name: "Voucher belanja", valueIdr: program.prizes.silver, imageUrl: null },
    { rankFrom: 3, rankTo: 3, name: "Kaos eksklusif", valueIdr: program.prizes.bronze, imageUrl: null },
  ];
}

export function findProgram(slug: string | undefined): Program {
  const found = PROGRAMS.find((p) => p.slug === slug);
  const first = PROGRAMS[0];
  if (found !== undefined) return found;
  if (first === undefined) throw new Error("no programs");
  return first;
}
