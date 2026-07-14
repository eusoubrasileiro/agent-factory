# Contract — agentes-evidence

Files you may touch: `scripts/board-report.mjs` + its test. Nothing else.
The aggregation core is `aggregateAgents(missions)` (exported) and the tab renderer
near it. M4 added tooltip/legend machinery — REUSE its definition-constant pattern for
your column definitions; do not invent a second mechanism.

## A — the denominator is always visible

- A1 The Agentes panel opens with a coverage line:
  `dados de N de M missões (X sem stats)` where M = all missions in the model, N =
  missions that contributed to the table. Zero-coverage renders the existing empty
  state PLUS the M count ("0 de 12 missões com dados").
  *Mutation gate: drop the coverage line → named test red.*
- A2 The coverage counts come from the same missions array the table aggregates —
  never a separate recount that could drift.

## B — honest cells (E1-d law)

- B1 `aggregateAgents` already yields null for unmeasurable cells; verify every column
  renders `—` (never `0`, never empty) when null: PASS de 1ª with zero eligible
  missions, tokens/feature with no token data, $/feature with no cost data.
  *Mutation gate: zero-fill one null cell in the renderer → named test red. If such a
  test already exists, extend it to cover every column; do not duplicate.*
- B2 A model whose every cell is null still gets its row (missions count is real) —
  suppressing it would hide that missions ran unmeasured.

## C — scope note

- C1 Below the table: one muted line stating the scope — "só missões deste projeto" —
  because per-project boards aggregate per-project missions (post-C1-fix truth). Keep
  it a literal in the definitions constant (M4 pattern) so the legend carries it too.

## Gate

`pnpm test` green from worktree root; existing tests stay green. No product literals.
Small commits on `agent/agentes-evidence`. Handoff at
`missions/factory/agentes-evidence/features/01.handoff.md`.

## Out of scope

New metrics/columns, aggregation formula changes, Histórico, client view.
