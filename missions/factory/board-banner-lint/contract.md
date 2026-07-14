# Contract — board-banner-lint (F2)

Implement the TWO M4 features that were claimed in a commit but never written (verified:
zero `dataAsOf`/`stale`/`⚠`/lint code in `scripts/board-report.mjs`). TDD: failing test
FIRST. `pnpm test` green before & after. No product literals in `scripts/**`. Files you may
touch: `scripts/board-report.mjs`, `scripts/board-report.test.mjs`. Nothing else. This branch
already contains F1 (the ⓘ tooltips) — do not touch `renderInfoTip`, the term constants, or
the tooltip CSS/JS.

## A — staleness banner (a board opened hours later must SAY it may be stale)
The board is static HTML with `generatedAt` (ISO) already in the model + a `<script>`. Staleness
is a VIEW-TIME fact (the file can be served long after it was generated), so it needs a pure
decision + a client-side reveal.
- **A1** Pure helper `stalenessText(generatedAtMs, nowMs, thresholdMs = 30*60*1000)` → returns
  a PT string like `dados gerados há 2 h — podem estar defasados` when `nowMs - generatedAtMs
  > thresholdMs`, else `null`. Humanize the age (min/h/dias). Deterministic; no `Date.now()`
  inside the pure fn (now is a param).
  *Mutation gate: fresh (gap 0) → null; gap 31 min → non-null containing "defasad". Lowering
  the threshold check to `>=0` (always stale) must break a "fresh → no banner" test.*
- **A2** Render a banner CONTAINER at the top of `<body>` (above the tabs), hidden by default,
  carrying `data-generated-at="<ISO>"` and an empty text slot. Add client JS (in the existing
  board `<script>`) that on load reads `data-generated-at`, computes `Date.now() - generated`,
  and if over the 30-min threshold fills the slot via `stalenessText`-equivalent logic and
  unhides the banner (`role="status"`). Fresh boards show nothing.
  *Node tests: the container + `data-generated-at` + the client threshold logic are emitted.
  The VISIBLE reveal is proven by the F0 Playwright probe (inject an old timestamp → banner
  shows).*

## B — contradiction lint (⚠ chip on impossible states — lint, never hide)
Detect states that cannot both be true and flag them so a viewer distrusts the right card.
- **B1** Pure helper `missionContradictions(mission)` → `string[]` of human PT reasons, for:
  1. `status === "Done"` AND `lastVerdict == null` → `"concluída sem veredito registrado"`.
  2. `gateReason === "approve-plan"` AND `handoffs > 0` → `"aguardando aprovação do plano, mas já há trabalho entregue"`.
  3. `gateReason === "ratify"` AND `lastVerdict?.verdict === "FAIL"` → `"marcada para ratificar com último veredito FAIL"`.
  A mission with none returns `[]`. Pure over the mission object.
  *Mutation gate: a Done+null-verdict fixture yields exactly reason (1); a clean mission yields
  `[]`. Deleting a rule drops its reason → red.*
- **B2** On each mission card whose `missionContradictions` is non-empty, render a `⚠` chip
  (`class="chip chip-contradicao"`, reuse the existing `.chip` pattern @718) whose
  `title`/`aria-label` lists the reasons joined by `; `. No contradictions → no chip.
  *Mutation gate: a card with a seeded contradiction contains `chip-contradicao` and the reason
  text; a clean card does not. Count-based, not a `<style>`-string match (that false-red bit
  M3 — assert rendered chips, not CSS class names in the stylesheet).*

## C — no regressions
- `pnpm test` fully green. `esc()` every interpolated reason/age. `node:*` only. Determinism:
  the banner's build-time output must not embed `Date.now()` (the age is computed client-side
  at view time; the server emits only the ISO stamp) — so two renders of identical state are
  byte-identical (there is a determinism test in the suite; keep it green).
- Do not alter F1 tooltips, lane logic (M3), or Agentes/coverage (M7).

## Rendered-DOM acceptance (validator, F0 probe)
Per `projects/factory/validation.md`, at 390 + 1440: inject an old `data-generated-at` (via
`browser_evaluate` setting the attribute then re-running the init, or load a fixture) → the
staleness banner is VISIBLE with "defasad" text. A board/mission seeded with a Done+no-verdict
mission shows the ⚠ chip; hovering/focusing it surfaces the reasons.

## Gate
`pnpm test` green from the worktree. Small commits on `agent/board-banner-lint`. Handoff at
`missions/factory/board-banner-lint/HANDOFF.md` naming the mutation-gate tests.
