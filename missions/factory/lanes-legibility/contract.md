# Contract — lanes-legibility

Read `docs/plan-B-board-legibility-2026-07-11.md` §F2 and §F3 first — it is the spec.
Files you may touch: `scripts/board-report.mjs`, `scripts/board-sync.mjs`, their two
test files. Nothing else.

## F2 — split Needs Human (presentation-layer; keep deriveMissionState untouched)

- A1 The Missões kanban renders the Needs-Human population as THREE lanes, in order:
  **Aprovar plano** (missions whose `gateReason` is `gate:approve-plan`),
  **Aprovar merge** (`gate:ratify`), **Escalado** (`gate:escalated`). A gateReason
  outside those three (or null while status is "Needs Human") falls into a fourth
  fallback lane **Needs Human (outro)** — never dropped silently.
  *Mutation gate: map `gate:ratify` into Aprovar plano → named test red.*
- A2 The header (or top of the Missões panel) shows the three counts:
  `N para aprovar plano · N para aprovar merge · N escalados` (omit zero-count parts).
- A3 Lane headings stay `<h2>` (audit A3 fixed heading order — do not regress; the
  existing test "audit A3: mission lane headings are <h2>" must stay green).

## F3 — honest lane semantics

- B1 Mission lane `Intake` renders as **Sem contrato** (display only; the derived
  status string in the model stays "Intake" so nothing downstream breaks).
- B2 A Sem-contrato card whose dossier has `stats.json` with any tokens/LOC spend shows
  a `trabalho iniciado` chip — never "no contract yet" bare next to real spend.
- B3 Parked: a dossier containing a marker file `PARKED` (any content) derives status
  `Parked` in board-sync's derivation, rendered in a collapsed `<details>` section
  **Estacionado** below the active lanes, never inside them.
  *Mutation gate: ignore the PARKED marker → named test red.*

## MERGED ⇒ Done (Plan A ratified decision 1)

- C1 A mission whose `branch.merged === true` renders in the **Done** lane regardless
  of gate state; if it lacks a `RATIFIED` marker it carries a small chip
  `não ratificado` (title: "mergeado sem ratificação registrada").
  *Mutation gate: drop the merged-overrides-gate rule → named test red.*
- C2 Done-by-merge must NOT lose the last verdict display.

## Regression safety

- All existing tests stay green (`pnpm test` from worktree root). The Histórico/audit
  regression tests in `board-report.test.mjs` are load-bearing — run them early.
- No product literals in `scripts/` (meta-test enforces; fixtures use generic slugs).

## Out of scope

Tooltips/legend/staleness/lint chips (M4), Agentes tab (M7), client view (M5).
