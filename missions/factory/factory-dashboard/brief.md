# Mission Brief — factory-dashboard

**Requirements:** none (meta — factory tooling, not a Tenant A backlog row)

## Problem
Andre (and soon Tenant A + Operator) cannot see the factory at a glance: which of the 18
backlog requirements (A1–D3 in `docs/prd/nexus-build-backlog.md`) is implemented by
which mission, on which branch, in what live state. The kanban board (`pnpm board`)
shows cards but not the requirement→mission→feature→branch traceability chain, and it
is local-only.

## Why now
Tenant A should watch his asks move without a standup; Operator onboards by reading the
pipeline; Andre ratifies from evidence. A static dashboard at
`factory.example.com/scrumban` (basic-auth: andre, tenant-a, operator) closes the gap.

## What (WHAT, not HOW)
- A generator (`pnpm board:report`) that reads REAL disk state — mission dirs, verdicts,
  markers, backlog PRD rows, git branches — and emits ONE self-contained static HTML
  dashboard (Portuguese UI) with three views: Requisitos, Missões, drill-down.
- A canonical requirement↔mission join: an explicit `**Requirements:**` line in each
  mission's brief.md. Local acceptance-criteria IDs in contract/plan NEVER map (the
  role-funcionario C1–C3 collision must stay unmapped).
- A publish script (`pnpm board:publish`) that rsyncs the generated site to the VPS.
- Deploy artifacts (compose + runbook) copying the proven lead-searcher basic-auth
  pattern. VPS execution itself is Andre-manual.

## Out of scope
Live server / auto-refresh; editing state from the browser; any product code; running
anything on the VPS during this mission.
