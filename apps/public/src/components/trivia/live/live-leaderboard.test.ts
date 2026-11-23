// The leaderboard follows the prize tiers (lib/play/prize-ranks.ts): a medal only on a rank a tier covers, in that tier's colour (the
// prize list's), a screen reader hearing the rank and the prize, and a phone showing every winner (at least 5) before "Lihat semua".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type BoardData, LiveLeaderboard } from "./live-leaderboard.tsx";

const DIET90 = [
  { rankFrom: 1, rankTo: 1, name: "Saldo e-wallet", valueIdr: 1_000_000 },
  { rankFrom: 2, rankTo: 6, name: "Voucher belanja", valueIdr: 500_000 },
];

const board = (rows: number, meRank: number | null = null): BoardData => ({
  top: Array.from({ length: rows }, (_, i) => ({ rank: i + 1, name: `Pemain ${String(i + 1)}`, score: 100 - i, totalMs: 1000 * (i + 1) })),
  me: { rank: meRank, name: "Kamu Sendiri", score: 10, totalMs: 5000, ranked: 40 },
  ageMs: 0,
});

const render = (tiers: typeof DIET90, data: BoardData): string => renderToStaticMarkup(createElement(LiveLeaderboard, { programId: "p", initial: data, tiers }));
/** Every table row as markup, the header first. */
const allRows = (html: string): string[] => html.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? [];
/** The top-N rows (the header, and the gap and the player's own row below it, left out). */
const rowsOf = (html: string): string[] => {
  const rows = allRows(html).slice(1);
  const gap = rows.findIndex((row) => row.includes("⋮"));
  return gap < 0 ? rows : rows.slice(0, gap);
};
/** The player's own row below the gap, or "" when the player is in the top N. */
const ownRow = (html: string): string => {
  const rows = allRows(html);
  return rows.some((row) => row.includes("⋮")) ? (rows[rows.length - 1] ?? "") : "";
};
const MEDAL = 'data-testid="rank-medal"';

describe("the leaderboard's medals follow the prize tiers", () => {
  it("DIET90 (rank 1, then ranks 2-6): medals exactly on ranks 1-6, rank 1 gold and ranks 2-6 silver, none from rank 7", () => {
    const rows = rowsOf(render(DIET90, board(10)));
    const medals = rows.map((row) => (row.includes(MEDAL) ? (/text-(accent|muted-foreground|warning|primary)"/.exec(row)?.[1] ?? "?") : null));
    expect(medals).toEqual(["accent", "muted-foreground", "muted-foreground", "muted-foreground", "muted-foreground", "muted-foreground", null, null, null, null]);
  });

  it("gives a screen reader the rank and the prize, and hides the visible number from it so the rank is not read twice", () => {
    const rows = rowsOf(render(DIET90, board(10)));
    expect(rows[0]).toContain("Peringkat 1, hadiah Saldo e-wallet Rp 1.000.000");
    expect(rows[1]).toContain("Peringkat 2, hadiah Voucher belanja Rp 500.000");
    expect(rows[0]).toContain('aria-hidden="true">1</span>');
    // The visible rank number stays everywhere, with or without a medal.
    expect(rows[6]).toContain(">7<");
    expect(rows[6]).not.toContain("hadiah");
  });

  it("has no medal at all with no prize tiers; one prize rank gives only rank 1 a medal; three give ranks 1-3 (bronze for the third tier)", () => {
    expect(rowsOf(render([], board(10))).filter((row) => row.includes(MEDAL))).toHaveLength(0);
    expect(rowsOf(render(DIET90.slice(0, 1), board(10))).map((row) => row.includes(MEDAL))).toEqual([true, ...Array<boolean>(9).fill(false)]);
    const three = [
      { rankFrom: 1, rankTo: 1, name: "Satu", valueIdr: 0 },
      { rankFrom: 2, rankTo: 2, name: "Dua", valueIdr: 0 },
      { rankFrom: 3, rankTo: 3, name: "Tiga", valueIdr: 0 },
    ];
    const rows = rowsOf(render(three, board(10)));
    expect(rows.map((row) => row.includes(MEDAL))).toEqual([true, true, true, ...Array<boolean>(7).fill(false)]);
    expect(rows[2]).toContain("text-warning");
    // A tier with no value reads as its name only.
    expect(rows[0]).toContain("Peringkat 1, hadiah Satu<");
  });

  it("applies the same rule to the player's own row below the gap (a rank a tier covers, when the board is shorter than the winners)", () => {
    const mine = ownRow(render(DIET90, board(3, 5)));
    expect(mine).toContain("Kamu Sendiri");
    expect(mine).toContain(MEDAL);
    expect(mine).toContain("text-muted-foreground");
    expect(mine).toContain("Peringkat 5, hadiah Voucher belanja");
    // Outside every tier: the plain number, no medal.
    const outside = ownRow(render(DIET90, board(3, 20)));
    expect(outside).toContain("Kamu Sendiri");
    expect(outside).not.toContain(MEDAL);
    expect(outside).toContain(">20<");
  });
});

describe("the rows a phone shows before 'Lihat semua'", () => {
  const hidden = (html: string): number => rowsOf(html).filter((row) => row.includes("hidden md:table-row")).length;
  const button = (html: string): boolean => html.includes("Lihat semua");
  const range = (to: number) => [{ rankFrom: 1, rankTo: to, name: "Hadiah", valueIdr: 0 }];

  it("is max(5, winners) of the server's rows: 6 prize ranks show 6 of 10, 10 show all 10 (and no button), 1 or 3 show 5", () => {
    expect(hidden(render(DIET90, board(10)))).toBe(4);
    expect(button(render(DIET90, board(10)))).toBe(true);
    expect(hidden(render(range(10), board(10)))).toBe(0);
    expect(button(render(range(10), board(10)))).toBe(false);
    expect(hidden(render(range(1), board(10)))).toBe(5);
    expect(hidden(render(range(3), board(10)))).toBe(5);
    expect(hidden(render([], board(10)))).toBe(5);
  });

  it("never folds the player's own row away: a player at rank 8 of 10 still sees their row on a phone, the others from rank 6 stay folded", () => {
    const html = render([], board(10, 8));
    const rows = rowsOf(html);
    expect(rows).toHaveLength(10);
    expect(rows[7]).toContain("Kamu"); // the "you" badge
    expect(rows[7]).not.toContain("hidden md:table-row");
    expect(rows.filter((row) => row.includes("hidden md:table-row"))).toHaveLength(4);
    // Inside the first rows nothing changes, and a player past the server's rows is the row below the gap (never folded either).
    expect(rowsOf(render([], board(10, 2))).filter((row) => row.includes("hidden md:table-row"))).toHaveLength(5);
    expect(ownRow(render([], board(10, 40)))).not.toContain("hidden md:table-row");
  });

  it("is bounded by the rows the server sends, and the button appears only when there are more rows than shown", () => {
    expect(hidden(render(range(10), board(8)))).toBe(0);
    expect(button(render(DIET90, board(6)))).toBe(false);
    expect(button(render(DIET90, board(7)))).toBe(true);
    expect(button(render([], board(5)))).toBe(false);
    expect(button(render([], board(6)))).toBe(true);
  });
});
