# Admin Reports Page Overrides

> **PROJECT:** Admin Console | **Page:** reports (sales, delivery, postback, profit/ROI, trivia; AC-A4..A9) | **Locale:** English
> Overrides `../MASTER.md`. The Master's marketing "Real-Time / Operations Landing" pattern does NOT apply; this is a dense data application. Themes `data-theme="admin-light"` and `admin-dark` are designed together; dark is the default.

## Layout
- App shell: left sidebar (240px, collapsible to a 56px rail) at >= 1024px; top bar with drawer below 1024px. Content is fluid, 16px gutters, 12px card gaps.
- Page order, identical for every report: title row (name, "Updated hh:mm WIB", Export CSV) > filter bar > KPI tiles > charts > data table.
- Tested at 375 (tables scroll inside their own container with sticky first column, KPI tiles 2-up), 768, 1024, 1440.

## Filter bar
- Sticky under the top bar (`--z-sticky`), `card` surface, 8px padding, wraps on small screens.
- Controls (labelled, 36px high, 14px text): date range (presets Today / 7d / 30d / This month / Custom, labelled "WIB"), Program, Landing page, Adnet, Gateway, Status (multi-select with count badge). "Reset" text button and "Apply" primary button; filters apply on Apply, not per keystroke.
- Active filters appear as removable chips (remove target >= 24px, `aria-label` "Remove filter: Gateway = Midtrans"); chips wrap before truncating.
- Filter state lives in the URL query (deep link, back-button restore).

## KPI tiles
- Grid `repeat(auto-fit, minmax(160px, 1fr))`. Tile = 12px muted label, value in Fira Code 24px `tabular-nums`, delta with arrow icon + signed text (`+4.2%`), optional decorative sparkline (aria-hidden).
- AC-A4/A5 tiles: Visits, MO, MT, MO to MT %, Gross revenue (`Rp 1.250.000`), plus Net/ROI on profit views. Locale-aware formatting.
- Tiles are not interactive cards (no hover lift). Loading: skeleton of identical size.

## Charts (follow the `dataviz` skill)
- Daily chart: line/area for trends (visits, MO, MT), bars for revenue per day; max 4 series; one y-axis per chart, no dual axes.
- Categorical palette validated in both themes; direct end-of-line labels plus a clickable legend. Series also differ by marker shape or dash pattern, never colour alone. Gridlines at low contrast; data marks >= 3:1 against `card`, data text >= 4.5:1.
- Tooltips on hover AND keyboard focus (arrow keys move between points) with exact values and date.
- Each chart has a text summary (figcaption, "Revenue rose 12% to Rp ... over 30 days") and a "View as table" toggle.
- No entrance animation by default; at most 250ms when motion is allowed.
- Empty: "No data for these filters" + Reset. Error: message + Retry. Loading: skeleton.

## Data tables
- Real `<table>`, `<th scope="col">`, sticky header (`top: var(--filter-bar-h)`) with solid `card` background and bottom border; optional sticky first column.
- Row height 36px (density toggle to 44px), 14px text; numerics Fira Code `tabular-nums`, right-aligned; text left-aligned; no zebra; row hover `muted` at 150ms.
- Sortable columns: header contains a `<button>`; `<th aria-sort="ascending|descending|none">`; Phosphor `CaretUp/CaretDown/CaretUpDown` icon plus visually-hidden text; click cycles asc > desc > none; server-side sort above 1k rows.
- Pagination footer: rows per page (25/50/100), "1-50 of 2,340", labelled prev/next, keyboard operable.
- Status cells are badges with icon + text (Paid, Pending, Failed, Refunded).
- Long tokens (order refs, URLs, postback responses) use `overflow-wrap:anywhere`; full value available in row detail or a keyboard-reachable tooltip.
- Totals footer row where meaningful. Virtualize above 200 rendered rows.
- Row actions (e.g. manual re-fire) are icon buttons with `aria-label`s; irreversible ones confirm in a Dialog.

## CSV export
- "Export CSV" (secondary, Phosphor `DownloadSimple`) in the title row, **visible only to the Owner role**: not rendered at all for other roles (never merely disabled); the API enforces the same rule (AC-A5). While exporting: disabled + spinner + "Preparing...", then a toast "Export ready". Export honours current filters (helper tooltip says so).

## Typography overrides
- Fira Sans for headings (600; page title 20px, card titles 14px/600). Fira Code only for numerals, IDs and code (overrides Master heading font for readability in dense screens).
- Body 14px/1.45; table text >= 13px; labels >= 12px.

## Color overrides
- Dark: background `#0F172A`, card `#1B2336`, border `#475569`, text `#F8FAFC`, muted text `#94A3B8`, accent `#22C55E`. Light: background `#F8FAFC`, card `#FFFFFF`, border `#CBD5E1`, text `#0F172A`, accent `#15803D`. Dark uses lighter tonal status colours, not inverted ones. Source of truth: `packages/ui/src/tokens.css`.
- Master `.btn-primary` (white on green) fails contrast; use `text-on-accent` / `text-on-primary` tokens only.
- Status colours pair with an icon and a label.

## Motion
- Subtle (dial 2/10): 150ms colour/opacity transitions only. Master's ScrollTrigger reveal is removed (a data page must never hide content). No stagger. `prefers-reduced-motion` removes remaining transitions.

## Accessibility
- 2px `ring` focus outline with 2px offset on all controls; tab order equals visual order; skip link to main; applying filters announces the result count once through a polite live region ("2,340 results").
- Targets >= 24px on desktop, 44px for primary controls on mobile.
