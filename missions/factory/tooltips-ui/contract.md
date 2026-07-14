# Contract — tooltips-ui (F1)

Presentation-only change to `scripts/board-report.mjs`. TDD: write each failing test FIRST.
`pnpm test` green before and after. No product literals in `scripts/**`
(`scripts/project-profile.test.mjs:370`). Files you may touch: `scripts/board-report.mjs`,
`scripts/board-report.test.mjs`. Nothing else.

## Problem being fixed
Today the KPI definitions render ONLY as `title="${esc(term.def)}"` on `.stat-card`
(board-report.mjs:1362), on the status badge (:1377), and on Agentes `<th title>` (:1445).
Native `title=` is invisible on hover (missed) and dead on touch. Replace it with a visible,
focusable affordance whose definition is revealed on hover AND on tap/focus.

## A — a reusable visible ⓘ affordance

- **A1** Add a pure helper `renderInfoTip(def)` that returns markup for a **visible** info
  affordance: a focusable element (a `<button type="button" class="info-tip">` or
  `<span class="info-tip" tabindex="0">`) bearing a visible glyph (ⓘ / “i”) and carrying
  the definition text in a child element (e.g. `<span class="info-tip__bubble" role="tooltip">${esc(def)}</span>`).
  The def string MUST come from the term constant passed in — never a second literal.
  *Mutation gate test: `renderInfoTip("X")` output contains `role="tooltip"`, a `tabindex`
  or `<button`, and the text `X`. Removing the visible element (leaving only a bare
  attribute) turns it red.*
- **A2** Each Histórico stat-card (renderHistoryTab, the `cardsHtml` map @1359) renders a
  `renderInfoTip(term.def)` INSIDE the card, and each Agentes column `<th>` (@1445) renders
  one in the header. The old `title="${esc(term.def)}"` as the SOLE mechanism is removed
  (you MAY keep `title=` additionally as a redundant native fallback, but a visible tip must
  exist — a test asserts the visible affordance count == terms count on each surface).
  *Mutation gate: a test counts `class="info-tip"` occurrences in the Histórico panel and
  asserts it equals `HISTORICO_TERMS.length`; same for Agentes `<th>` vs `AGENTES_TERMS.length`.
  Reverting a card to title-only drops the count → red.*
- **A3 (PRESERVE the existing gate)** The def text in every tip MUST be the exact same
  string as the `renderLegenda` list item for that term (they read the SAME constant). The
  existing A3 mutation gate (tooltip def === legenda def) must stay green — do NOT fork the
  definitions into separate literals.

## B — accessibility + reveal mechanics (works with mouse AND finger)

- **B1** ARIA: the focusable element associates its bubble via `aria-describedby="<id>"`
  pointing at the `role="tooltip"` bubble (unique id per tip), OR carries an `aria-label`
  with the def. A keyboard user tabbing to it, and a screen reader, both reach the definition.
  *Test: the rendered tip has `aria-describedby` matching the bubble's `id`, OR an `aria-label`
  containing the def.*
- **B2** CSS: add rules so the bubble is hidden by default and revealed on **`:hover`,
  `:focus`, and `:focus-within`** of the affordance (desktop hover + keyboard/tap focus).
  *Test: the page `<style>` contains a selector combining `.info-tip` with `:hover` and a
  selector with `:focus` (or `:focus-within`) that toggles the bubble’s visibility/display.*
- **B3** Touch tap-toggle: extend the board's existing `<script>` (the tab `activate` IIFE)
  so tapping/clicking an `.info-tip` toggles an `open`/`aria-expanded` state (tap to show,
  tap again or tap elsewhere to hide) — `:focus` alone is unreliable on iOS.
  *Test: the rendered `<script>` references `info-tip` and toggles a class or
  `aria-expanded`. (The VISIBLE behavior itself is proven by the F0 Playwright probe, not
  this node test.)*

## C — no regressions
- **C1** `renderLegenda` unchanged in output; the `<details class="legenda">` still lists
  every term. The Histórico "sem dados ainda" empty branch still renders the legenda.
- **C2** `pnpm test` fully green (788+ pass). No new dependency; `node:*` only. `esc()` on
  every interpolated def. Deterministic (no wall-clock, no Math.random for ids — derive ids
  from the term label/index).

## Rendered-DOM acceptance (validator seat, F0 probe — NOT a node test)
Per `projects/factory/validation.md`: serve the rendered board, drive with Playwright at
**390×844 and 1440×900**, on `/factory/` Histórico tab and Agentes tab:
- The ⓘ affordance is visible next to each tile value / column header.
- **Hover** (1440) reveals the definition text; **tap/click** (390) reveals it; tap-away hides it.
- A bare `title=`-only tile is a FAIL. Evidence: `browser_snapshot` + screenshot.

## Gate
`pnpm test` green from the worktree. Small commits on `agent/tooltips-ui`. Handoff at
`missions/factory/tooltips-ui/HANDOFF.md` naming which tests are the mutation gates.
