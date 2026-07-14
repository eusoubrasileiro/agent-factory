# Contract — vocabulary-trust

Read `docs/plan-B-board-legibility-2026-07-11.md` §F4 + §F5 first. Files you may touch:
`scripts/board-report.mjs`, `scripts/board-index.mjs`, their two test files. Nothing else.

## F4a — every KPI explains itself

- A1 Every Histórico stat tile carries a `title="..."` attribute with a one-sentence
  PT definition INCLUDING its data source, e.g. lead time mediano → "mediana, criação
  do dossiê até Done (history.jsonl)"; economia (API–plano) → "custo API estimado das
  missões menos a mensalidade do plano fixo". No tile without a title.
  *Mutation gate: strip one tile's title → named test red (test asserts every
  `.stat-card` in rendered Histórico HTML has a non-empty title).*
- A2 Every Agentes column header carries a `title=` definition (same rule).
- A3 Each tab panel ends with a collapsed `<details class="legenda"><summary>o que
  significa cada número</summary>…</details>` listing its terms — content generated
  from the SAME definition strings as the tooltips (one constant, two surfaces; a
  definition edited in one place updates both).
  *Mutation gate: let legend and tooltip diverge (separate literals) → test comparing
  them red.*

## F4b — badge provenance

- B1 Status badges carry `title=` naming the source: derived-from-verdict ("estado
  derivado do validate.log"), PRD-typed ("Situação digitada no PRD"), intake lifecycle
  ("coluna do intake"). A viewer can tell a real Done from a typed "done".

## F5 — trust indicators

- C1 **Staleness banner:** `buildTraceabilityModel` stamps `dataAsOf` (newest mtime of
  its inputs: dossier files scanned, prd, history file — pass paths in; keep the
  function pure w.r.t. clock by comparing against `generatedAt`). When
  `generatedAt - dataAsOf > 30min`, render a visible banner `dados de <DD/MM/YYYY HH:MM>`
  under the header. Reuse `formatDateTime` (exported, board-report.mjs).
  *Mutation gate: banner threshold ignored → named test red (fixture with 2h gap).*
- C2 **Contradiction lint:** at render time flag impossible combos with a `⚠` chip
  (title explains): mission with `gateReason gate:approve-plan` AND handoffs>0; Done
  with no verdict; Sem-contrato card with stats.json spend but no `trabalho iniciado`
  marker case is handled by M3 — do not duplicate. Lint renders the chip, never hides
  the card.
  *Mutation gate: suppress a contradiction chip → named test red.*

## Review Q1 — hide the empty Requisitos tab

- D1 A project with zero requirements (no PRD) renders NO Requisitos tab button and NO
  Requisitos panel (same existence rule the Intake tab already follows —
  `renderIntakeTab` returns "" when empty; mirror it). Default-tab logic must still
  land on Missões (existing tests pin this — keep them green, adjust only if they
  assert the tab's existence).
  *Mutation gate: render the empty tab again → named test red.*
- D2 With requirements present, tab renders exactly as today (regression tests stay).

## Gate

`pnpm test` green from worktree root; all existing audit regression tests stay green.
No product literals in `scripts/**`. Small commits on `agent/vocabulary-trust`.
Handoff at `missions/factory/vocabulary-trust/features/01.handoff.md`.

## Out of scope

Lane structure (M3), Agentes aggregation logic (M7), client view (M5),
standards/factory-process.md (coordinator).
