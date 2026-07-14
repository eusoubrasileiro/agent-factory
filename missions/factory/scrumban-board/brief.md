# Brief — scrumban-board

> Author: Andre (via orchestrator, from ratified plan `docs/dev/scrumban-backlog-factory-plan-2026-07-07.md`). Reader: orchestrator.
> Ratified 2026-07-07: M-01 (two-canonical split), M-06 (PASS → Needs Human, never auto-Done), M-08 (retire the hand-edited status column). Decisions M-01…M-11 in the plan doc are final.

## Problem

Factory execution status lives in Andre's head plus a hand-edited markdown table
(`docs/prd/nexus-build-backlog.md` `Situação` column). There is no glanceable surface
showing which missions need his attention, what is building/validating, and what is
waiting in intake. His attention is the factory's bottleneck (v2 KPI:
attention-per-feature) and today it is spent *finding out* state, not deciding.

## Who it serves

Andre first (his `Needs Human` queue at a glance); Tenant A and any future teammate second
(watch the pipeline without a standup). Also makes the factory itself demoable as a way
of working.

## Outcome — what "good" looks like

- `pnpm board` shows one card per `factory/missions/<slug>/` in a column derived purely
  from on-disk state: Intake · Planning · Building · Validating · Needs Human · Done · Blocked.
- Validator PASS instantly lands the card in `Needs Human (gate:ratify)` — **never Done**.
  Only the on-disk `RATIFIED` marker (written by `pnpm mission:ratify <slug>` after the
  human merge) moves a card to Done.
- The 18 rows of `nexus-build-backlog.md` are seeded as cards; its `Situação` column is
  deprecated with a banner.
- The board is a soft layer: `mv backlog/ /tmp` and the whole factory still plans, builds,
  validates and records verdicts green.

## Out of scope / do not touch

- NO product code: `backend/src/**`, `frontend/**`, `shared/**`, `prisma/**`,
  `backend/src/bot/**`, `backend/src/lib/waba.ts`.
- No two-way sync, no Backlog.md `onStatusChange` hook, no web-board customization.
- No CI, no paid LLM calls, no evals.

## Notes / constraints

- Backlog.md task files are written only through its CLI (`backlog task create/edit`);
  never hand-edit `backlog/tasks/*.md` frontmatter.
- The hard gate (`verdict.mjs`, `quality-gate`, git) must never *depend* on Backlog.md —
  hook calls are best-effort, exit codes unchanged.
- Soft WIP warnings only: `Needs Human ≤ 5`, `Building+Validating ≤ 3` (warn, never block).
