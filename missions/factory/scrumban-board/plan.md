# Plan — scrumban-board

> Author: orchestrator. Readers: Andre, workers, validator.

## Summary

Install Backlog.md (`backlog.md` npm package, CLI bin `backlog`) in-repo as a one-way
projection of factory mission state. Pure `deriveMissionState()` core + idempotent
`board-sync.mjs` shell; soft-fail hooks at lifecycle transitions; one-time importer for
the 18 PRD backlog rows; on-disk `RATIFIED` marker closes the loop. Zero product code.

## Milestones

1. Board scaffold + projector proven against fixtures (features 01).
2. Lifecycle hooks live: verdict-append, plan-approval, build transitions (feature 02).
3. Intake seeded + legacy column retired (feature 03).
4. Ratify path + docs + D-08 (feature 04).

## Features

| NN | Feature | Milestone | Depends on | Touches |
|----|---------|-----------|------------|---------|
| 01 | Scaffold + projector (`deriveMissionState` + `board-sync.mjs`) | 1 | — | `backlog/` (new), root `package.json`, `scripts/factory/board-sync.mjs` + `board-sync.test.mjs` |
| 02 | Hook wiring (verdict soft-fail hook, APPROVED marker, skill lines) | 2 | 01 | `scripts/factory/verdict.mjs`, `scripts/factory/verdict-hook.test.mjs` (new), `.claude/skills/mission-{plan,build,validate}/SKILL.md` |
| 03 | Intake importer + Situação banner | 3 | 01 | `scripts/factory/board-import-backlog.mjs` + `.test.mjs` (new), `docs/prd/nexus-build-backlog.md` |
| 04 | Ratify → Done + merge-pr wiring + docs + D-08 | 4 | 01, 02 | `scripts/factory/ratify.mjs` + `.test.mjs` (new), root `package.json`, `.claude/skills/merge-pr/SKILL.md`, `factory/RUNBOOK.md`, `factory/decisions.md` |

Workers run strictly serially (constitution C2) in this worktree, branch
`agent/scrumban-board`. Model tiering (v2 R6): feature 01 = Opus; 02–04 = Sonnet;
validator = Opus.

## Coverage check

| Contract assertion | Proven by feature |
|--------------------|-------------------|
| A1 (statuses config) | 01 |
| A2 (real-mission projection) | 01 |
| A3 (PASS→gate:ratify, FAIL ladder) | 01 (derive) + 02 (hook) |
| A4 (drift repair, idempotent) | 01 |
| A5 (soft layer) | 02 |
| A6 (importer + banner) | 03 |
| A7 (RATIFIED→Done, BLOCKED) | 01 (derive) + 04 (command) |
| A8 (WIP warnings) | 01 |
| GATE | all |

## Open questions for Andre

None — M-01/M-06/M-08 ratified 2026-07-07; the rest is engineering.
