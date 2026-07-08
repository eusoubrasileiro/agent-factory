# @amiticia/factory

AmiticIA's software factory — the AI-agent mission engine (plan → build →
validate → ratify) plus the live board that publishes to `factory.example.com`.

> **Provenance.** Extracted from `AmiticIA-AutoSys/wahub` @ `97eaa40` on
> 2026-07-08 (plan: *Factory v2.1 — Factory Extraction*, Workstream 0/2). Fresh
> repo, no history surgery. wahub keeps its product-owned quality contract
> (`quality-gate.mjs`, `quality-baseline.json`, `.husky` hooks, the PRD); the
> engine + all mission data live here and are reusable by other products via one
> `deploy/projects.json` entry.

## Layout

```
scripts/            # engine: board-*, verdict, ratify, metrics, git-autocommit,
                    #   history, opencode-worker, probe-secrets (+ *.test.mjs)
scripts/lib/        # project.mjs — the single path resolver (factoryRoot vs repoRoot)
skills/             # mission-plan | mission-build | mission-validate (Claude skills)
templates/          # dossier templates + external-seat.env
missions/<project>/ # per-project mission dossiers (spec of record, committed)
history.jsonl       # board history snapshots
decisions.md        # ratified factory decisions
constitution.md     # factory constitution
RUNBOOK.md          # operator runbook
deploy/             # projects.json manifest + DEPLOY-VPS.md + docker-compose
docs/               # harness research, glm-cage briefing, harness review
```

## Two roots (the one design rule)

Path resolution goes through `scripts/lib/project.mjs` → `resolveProject()`:

- **factoryRoot** — this repo. Holds `missions/<project>/<slug>/`,
  `history.jsonl`, `.publish.log`, `deploy/projects.json`, `dist/factory-board/`.
  Dossier auto-commits land here.
- **repoRoot** — the product repo (`deploy/projects.json` `path`, e.g.
  `../../products/wahub`). Holds the code workers edit, the `agent/*` branches
  board-report scans, the `backlog/` kanban, and the PRD. Product git commands
  run with `cwd = repoRoot`.

Every entry-point script accepts `--project <id>` (default: `$FACTORY_PROJECT`,
else the sole `projects.json` entry). Never use relative `../..` to escape a
worktree — factoryRoot comes from `$FACTORY_ROOT` (dispatch stamps it into a
worktree's `.agent-env`) or this repo's own location.

## Commands

```bash
pnpm test              # engine unit tests (node --test), autopublish/PR guarded off
pnpm board:report      # render one project's dashboard HTML
pnpm board:autopublish # idempotent publish funnel (hash-gated) → factory.example.com
pnpm board:publish     # rsync dist/factory-board/ to the VPS
pnpm mission:ratify    # ratify a validated mission
```
