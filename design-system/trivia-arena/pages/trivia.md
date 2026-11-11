# Trivia Page Overrides

> **PROJECT:** Trivia Arena | **Page:** `/trivia` (authenticated player page) | **Locale:** Bahasa Indonesia only (AC-Q14)
> Rules here **override** `../MASTER.md`. The Master's landing-page pattern (Hero + Testimonials + CTA) does NOT apply to this page.

Mood: exciting, trustworthy (money prizes), playful but premium. Blue/violet energy; gold is reserved for rank, prizes and the single primary CTA per card.

## Structure: exactly 4 cards, fixed reading order 1-2-3-4

DOM order is always banner, leaderboard, profile, grid. Desktop placement may rearrange visually but must never change DOM, reading or tab order.
A sticky top bar (program switcher + account menu) sits above the cards and reserves `--header-h` scroll padding so focus is never obscured.

| # | Card | Content |
|---|------|---------|
| 1 | Banner | Program name + cover art, prize tiers (gold/silver/bronze rows with Rp amounts), sales countdown then grace-period countdown, later masked winners (only after Owner confirmation). One countdown visible at a time, labelled ("Penjualan berakhir dalam", "Masa bermain berakhir dalam"). |
| 2 | Leaderboard | Top N rows (rank, masked name, score, total time) plus a pinned "Peringkat saya" row. Header shows "Diperbarui X lalu" and a "Perbarui" button. |
| 3 | Profile | Masked name (e.g. "Bu*** S***"), score, total time (mm:ss, tabular), sets completed "12/90", rank, "Set berikutnya terbuka dalam hh:mm:ss (00.00 WIB)". |
| 4 | Trivia grid | Thumbnail per set in locked / unlocked / completed states. |

### Card chrome
- `bg-card`, radius `--radius-xl` (16px), 1px `border`, `--shadow-md`. Cards are NOT clickable as a whole: no card-level hover lift, no cursor:pointer (overrides Master "Cards"). Only inner controls are interactive.
- Card header: Russo One 20px title, Phosphor duotone icon (aria-hidden) at 24px, optional trailing action.
- Vertical rhythm: 16px gap on mobile, 24px at >= 768px.

## Layout at breakpoints

| Width | Layout |
|-------|--------|
| 375 | Single column, 16px gutters, cards stack 1-2-3-4. Leaderboard shows top 5 + pinned row; "Lihat semua" expands inline (no nested scroll region). Grid: 2 columns. |
| 768 | Container max 720px centered, 24px gutters. Still a single stack 1-2-3-4 (side-by-side would not break order but wastes the narrow width). Grid: 3 columns. |
| 1280 | Container 1200px, 12-col grid. Row 1: banner spans 12. Row 2: leaderboard spans 7, profile spans 5 (row-major visual order equals DOM order 1-2-3). Row 3: grid spans 12 with 5 columns. |

No horizontal scroll at 375. Body text >= 16px. Use `min-h-dvh`, not `100vh`.

## Program switcher
Rendered only when the player owns >= 2 programs. Mobile: full-width trigger button in the sticky bar opening a bottom-sheet Dialog listing programs (thumbnail, name, "x/y selesai"). Desktop: segmented Tabs when <= 4 programs, otherwise a popover list. The selected program is in the URL (`?program=slug`) so reload and deep links keep it. All 4 cards switch together with skeletons (AC-Q3). Tabs use `role="tablist"` and arrow-key navigation.

## Leaderboard refresh rules (no polling)
- Data loads on page load, after the player's own answer submit, and via the "Perbarui" button only. Never on a timer.
- "Diperbarui X lalu" is derived client-side from the fetch timestamp, re-rendered at most every 30 s, `aria-live="off"`. Wording: "baru saja" (<10 s), "N detik lalu", "N menit lalu".
- "Perbarui": secondary button, min 44px, spinner + `aria-busy` while loading, disabled for 3 s afterwards. Failure: inline "Gagal memuat. Coba lagi." with retry; stale rows stay visible.
- Own row: `muted` fill + 4px primary left bar + "Kamu" badge (not colour alone). If outside top N, show an ellipsis row then the own row, pinned at card bottom.
- Ranks 1-3: medal icon + numeral. Rows are a real `<table>` (compact), tabular numerals.

## Trivia grid card
- Thumbnails are AI-generated art (AC-Q12), `aspect-ratio: 4/5`, explicit dimensions, lazy-loaded, WebP/AVIF.
- Each state differs by icon + text label + treatment, never colour alone:
  - **Locked**: art desaturated under the AI-generated lock overlay asset; label "Terbuka dalam 2 hari" or "Terbuka 14 Mei 00.00 WIB". Non-interactive element with `aria-disabled`; reads "Set 7, terkunci, terbuka ...". No hover affordance.
  - **Unlocked**: full colour, "Main" pill, 2px primary ring. Whole tile is one `<button>` (>= 44px; tiles ~160px). Opens the question flow.
  - **In progress** (partially answered, resumes per AC-Q7): amber ring + "Lanjutkan".
  - **Completed**: corner badge (Phosphor `CheckCircle` fill + "Selesai"), score "80/100". Not playable again (AC-Q6); optional "Lihat hasil".
- Next unlockable set gets a "Berikutnya" label. Stagger-in on load: 40ms per tile, 300ms, `back.out(1.4)` (Master) only here; none under reduced motion.
- 90 items: render as `<ul>`, use `content-visibility:auto` per row or windowing above 50.

## Question flow
Full-screen route (`/trivia/set/[id]`) on mobile; centered panel (max 640px, focus trapped, no outside-click dismiss) on desktop. Exiting mid-set asks for confirmation and states "Waktu tetap berjalan" because the server clock never pauses (AC-Q7).

Anatomy:
1. Header: "Set 7", progress "Soal 3 dari 10" (`<progress>` + text), exit button (44px).
2. Timer: ring (64px) on mobile, bar on desktop. Remaining seconds in the ring centre, Chakra Petch `tabular-nums`, fixed-width so digits never shift. Ring depletes via stroke-dashoffset, linear easing. Last 5 s: warning colour AND bold number AND visible "Waktu hampir habis" line. `role="timer"`, `aria-live="off"`; screen readers are told at 10 s and 5 s only (polite).
3. Question text (18-22px, line-height 1.5, <= 65ch) + optional image (fixed aspect-ratio, alt required).
4. Options: 2-4 full-width stacked buttons, min-height 56px, 12px gap, visible letter chip (A-D). One tap submits and locks every option immediately (no confirm, no edit; AC-Q8). After submit all options get `aria-disabled` and focus moves to the result region.
5. Result region: `role="status"`, `aria-live="polite"`.

| State | Visual | Non-colour cue | Next |
|-------|--------|----------------|------|
| Idle | `card` bg, 2px `input` border | letter chip | tap an option |
| Submitting | chosen option shows spinner, others dim to 60% | spinner | server response |
| Correct | chosen option `success` fill | `CheckCircle` + "Benar! +10 poin" | "Lanjut" (focused) |
| Wrong | chosen option `destructive` outline with `XCircle` + "Jawabanmu"; correct option revealed with `success` outline, `CheckCircle` + "Jawaban benar" (only now, AC-Q9) | icons + text | optional "Penjelasan" panel, then "Lanjut" |
| Timeout | ring empty; banner "Waktu habis. 0 poin." with `Hourglass`; correct answer revealed as in Wrong, no chosen option | icon + text | "Lanjut" |
| Last question | "Lanjut" becomes "Lihat hasil"; summary shows score, total time, rank, "Kembali ke daftar set" | text | exit |
| Network error | inline error + retry; timer keeps running (server clock) | text | retry |

"Lanjut" is the only primary action in the flow. No auto-advance.

### Motion
- Option press: 100ms background/opacity; no scale that shifts layout.
- Result reveal: 200ms fade + 8px translate (ease-out). Correct: one 300ms check pop (transform/opacity). Confetti only on set completion, single burst <= 1.2 s.
- Question change: 200ms crossfade.
- Tokens: `--duration-fast` 100ms, `--duration-base` 200ms, `--duration-slow` 300ms, `--ease-out`.
- `prefers-reduced-motion: reduce`: the ring steps once per second with no easing; fades, translate, pop, confetti and grid stagger are removed (final state renders instantly). Remaining time is always also shown as text, so nothing depends on animation.

## Typography overrides
- Russo One: card titles 20px, set title 24px, rank numerals 28-32px. Chakra Petch body 16px/1.5, labels 14px/500; 12px only for tertiary captions.
- Every changing numeral (timer, score, time, rank, countdowns) uses `tabular-nums`.

## Color overrides
- Primary blue: actions and own-row marker. Secondary violet: banner gradient/hero accents only. Accent gold: medals, prize amounts, and the "Lanjut"/"Main" CTA with `text-on-accent` (Master's `.btn-primary` white text on gold fails contrast).
- Success/warning/info/destructive come from semantic tokens and always pair with icon + text.
- Locked tiles: `foreground` scrim at 55% over the art + lock asset; label text sits on a solid `card` chip (>= 4.5:1), never directly on art.

## Component overrides
- Buttons: 48px min height, 12px radius; hover changes background only (no translateY; overrides Master).
- Focus: 3px `ring` outline with 2px offset, always visible.

## Accessibility
- Landmarks: `header`, `main`; each card is `<section aria-labelledby>` with an h2; page h1 is the program name. Skip link "Lewati ke konten". Focus returns to the originating tile when the question flow closes.
- Targets >= 44px with 8px gaps. WIB times always say "WIB". Masked names only; never full WhatsApp numbers.

## Empty / loading / error
- Per-card skeletons with identical dimensions (no layout shift). No program owned: "Kamu belum punya program" + CTA to the store. Empty leaderboard: "Belum ada pemain di papan peringkat. Jadilah yang pertama!"
