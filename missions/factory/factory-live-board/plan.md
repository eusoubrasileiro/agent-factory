# Mission Plan — factory-live-board

Approved by Andre 2026-07-08 (plan-mode approval; git-flip decision delegated to and
made by the orchestrator). Seats: orchestrator = Fable; workers W1–W5 = GLM 5.2 via
`pnpm factory:opencode` (serial, constitution C2); validator = GLM 5.2 fresh session.
Graduated fix ladder (R9).

## Features → milestones

| Feature | Scope | Contract rows |
|---------|-------|---------------|
| 01 — missions enter git | .gitignore flip, pre-commit fast-path guard, verdict `ts` field, auto-commit in verdict/ratify | A1, A4 (partial) |
| 02 — autopublish funnel | `board-autopublish.mjs` (hash guard, dry-run, .publish.log), bindings in verdict/ratify/post-commit/post-merge | A2, A3, A4 |
| 03 — per-project | `--branch-prefix`/`--trunk` flags, projects.json, root index, per-project out dirs, /scrumban/ redirect, publish target `public/` | A5, A7 |
| 04 — history + Histórico tab | history.mjs snapshots, Histórico rendering (lead time, velocity, rondas, tokens, atenção-por-feature) | A6 |
| 05 — integration + backfill | commit existing mission dossiers, RUNBOOK + DEPLOY-VPS docs, real-repo end-to-end run | invariants, GATE |

## Fixed decisions (do not relitigate)
- Missions enter git: remove the `factory/missions/**` ignore. `deploy/factory-board/.env`,
  `dist/`, `factory/.publish.log` stay ignored.
- Autopublish is ONE idempotent funnel, git-write-free, soft-fail (never breaks its
  caller, always exits 0 in binding context). Bindings are fire-and-forget detached.
- Hash guard: content hash computed over rendered HTML with the `gerado em` timestamp
  line stripped; hash memo lives at `dist/factory-board/.hash` (dist is gitignored;
  losing it just causes one harmless republish).
- Auto-commits from verdict/ratify are pathspec-limited (`git commit -m <msg> -- <paths>`),
  message prefix `chore(factory):`, soft-fail (mid-rebase/detached HEAD → skip silently).
- Loop termination: post-commit → autopublish makes NO commits → no re-trigger. The
  verdict/ratify auto-commit fires post-commit → autopublish runs again → hash guard
  no-ops. Bounded, no recursion.
- projects.json manifest shape: `[{ "id": "wahub", "name": "Nexus CRM / WaHub",
  "repo": ".", "prd": "docs/prd/nexus-build-backlog.md" }]`. `repo` is relative to the
  wahub repo root (other repos later use absolute or `../` paths).
- URL layout: `/` root index · `/<project>/` dashboard · `/scrumban/` static
  meta-refresh redirect to `/wahub/`. rsync target becomes
  `deploy-host:/opt/app/factory/public/` (--delete is safe: the generator emits
  root+wahub+scrumban every run).
- History snapshot row: `{ts, project, slug, state, features:"m/n", rounds, verdict,
  reqIds}` appended per mission ONLY when the hash changed.
- Histórico metrics: missões concluídas/semana; lead time = first snapshot of slug →
  first snapshot with state Done; rondas = max round in validate.log; tokens = sum of
  metrics.jsonl `tokens`; atenção-por-feature = (touchpoint+intervention+escalation)
  ÷ features shipped (standards §12.c KPI). Missing data → "sem dados", never crash.
- House style = `scripts/factory/board-sync.mjs`: `#!/usr/bin/env node`, JSDoc, pure
  exported core + thin IO shell, main-guard, node:test with mkdtempSync fixtures.
