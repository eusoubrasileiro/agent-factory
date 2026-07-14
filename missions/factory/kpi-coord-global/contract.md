# Contract — kpi-coord-global (F4)

Fix `scripts/kpi.mjs` so `pnpm kpi` stops implying per-project coordinator-token
attribution it does not have. TDD: failing test FIRST. `pnpm test` green before & after.
No product literals in `scripts/**` (`scripts/project-profile.test.mjs:370`). Files you may
touch: `scripts/kpi.mjs`, `scripts/kpi.test.mjs` (create if absent). Nothing else.

## Problem
`coordinatorTokensForFactory` (kpi.mjs:284) is explicitly **factory-global** — its own
docstring says *"per-project attribution awaits the F4 session-tag join… v1 attributes the
factory-wide coordinator total to the window."* But `renderTable` prints `COORD-TOK`
(NUM_COLS, :332) as a **per-project column**, so the same large number repeats on every row
as if each project spent it. That is misleading. Note: `ATTN/FEAT`
(`attentionPerFeature = attention/features`, buildKpi:168) does **NOT** use coordinator
tokens — it is already per-project and correct; do not change its math.

## A — render the coordinator total ONCE, labeled global
- **A1** Remove the `COORD-TOK` entry from the per-project `NUM_COLS` table columns
  (kpi.mjs:329-335). The per-project table shows MERGED · SEAT-TOK · ATTN · ATTN/FEAT only.
- **A2** Compute the factory-global coordinator total ONCE (it already is —
  `coordinatorTokensForFactory`, called once in `main` via `coordinatorDir`) and render it as
  a single labeled line in `renderTable`, e.g. after the `◆ window` line:
  `◆ coordenador (fábrica, global): <n> tokens — não atribuível por projeto (v1)`.
  A null total renders `—` (E1-d law), never 0. Pass it on the `report` object as
  `report.coordinatorGlobal` (number|null); `renderTable` prints it once.
- **A3** `rowForProject`/`buildKpi` no longer need a per-row `coordinatorTokens` for the
  table. Keep `buildKpi`'s field for `--json` back-compat IF a test depends on it, but the
  TABLE must not carry a per-project coordinator column. Prefer: `main` sets
  `report.coordinatorGlobal` once; rows omit it.
- **A4 (`--json`)** The JSON output carries `coordinatorGlobal` once at the top level, not
  repeated per row. (If you keep a per-row field for back-compat, a test must document why.)

## Mutation gate
- A test builds a report with ≥2 projects and asserts the coordinator total string appears
  **exactly once** in `renderTable` output (not once per project row). Re-adding COORD-TOK as
  a per-row column → the count > 1 → red.
- A test asserts `ATTN/FEAT` still equals `attention/features` per project (unchanged), and a
  null coordinator total renders `—`.

## Verification (CLI, no Playwright)
- `pnpm test` green from the worktree.
- `node scripts/kpi.mjs` prints ONE `coordenador (fábrica, global)` line and a per-project
  table WITHOUT a repeated COORD-TOK column. `node scripts/kpi.mjs --json` has a single
  top-level `coordinatorGlobal`.

## Gate
`pnpm test` green. Small commits on `agent/kpi-coord-global`. Handoff at
`missions/factory/kpi-coord-global/HANDOFF.md` naming the mutation-gate tests.
