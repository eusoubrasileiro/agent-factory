# Mission Brief — factory-live-board

**Requirements:** none (meta — factory tooling, not a Tenant A backlog row)

## Problem
factory.example.com/scrumban is live but frozen in time: it only updates when Andre
manually runs `pnpm board:report && pnpm board:publish`. Root cause: `factory/missions/**`
is gitignored — mission state changes are plain filesystem writes, invisible to git,
so nothing can trigger a republish and the VPS can never pull. Also: the dashboard is
single-project (wahub hardcoded in the publish path), and there is no history — no way
to answer "how fast are we shipping, at what cost, with how much human attention".

## Why now
A stale dashboard is worse than none (Tenant A stops trusting it). A 2nd dev (Operator)
and more products are coming — mission state must become shared, and the dashboard
must become per-project. Andre explicitly asked for productivity tracking.

## What (WHAT, not HOW is fixed in plan.md)
- **Missions enter git**: flip the `factory/missions/**` gitignore. Mission dossiers are
  the spec of record; committing them gives multi-dev sync, real history, worktree
  access, and a future CI path. Pre-commit gate gets a fast-path for missions-only
  commits (markdown/JSONL can't break the build).
- **Auto-publish binding**: one idempotent funnel (`board-autopublish.mjs`) — render,
  content-hash guard, rsync, history snapshot — invoked fire-and-forget from
  `verdict.mjs`, `ratify.mjs`, and git `post-commit`/`post-merge` hooks. No daemons,
  no cron.
- **Per-project layout**: `factory.example.com/` = project index; `/<project>/` = that
  project's dashboard; `deploy/factory-board/projects.json` is the manifest.
  `/scrumban/` becomes a redirect to `/wahub/`.
- **History + velocity**: per-publish snapshots in `factory/history.jsonl`; a new
  **Histórico** dashboard tab: missões/semana, lead time, rondas do validador,
  tokens/custo, atenção-por-feature (the ratified factory KPI).

## Out of scope
GitHub Actions CI publish (phase 2, separate ratification); costUsd computation for
opencode runs; harness extraction to standards/ (wait for 3+ projects); editing state
from the browser; tenant-a/operator basic-auth passwords.
