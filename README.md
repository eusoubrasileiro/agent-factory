# @amiticia/factory

AmiticIA's software factory — the AI-agent mission engine (plan → build →
validate → ratify) plus the live board that publishes to `factory.example.com`.

> **▶ Start here:** [`RUNBOOK.md`](RUNBOOK.md) to operate it,
> [`constitution.md`](constitution.md) for the rules every seat obeys,
> [`decisions.md`](decisions.md) for why anything is the way it is.

> **Provenance.** Extracted from `AmiticIA-AutoSys/wahub` @ `97eaa40` on
> 2026-07-08 (plan: *Factory v2.1 — Factory Extraction*, Workstream 0/2). Fresh
> repo, no history surgery. wahub keeps its product-owned quality contract
> (`quality-gate.mjs`, `quality-baseline.json`, `.husky` hooks, the PRD); the
> engine + all mission data live here.

## The one architectural rule

**The engine knows the SHAPE of a project; only the profile knows the FACTS.**

Every per-project fact — gate commands, Critical Files, dummy-env shape, behavioral
validation — is **data** under `projects/<id>/`, never code under `scripts/`. A
conformance suite (`scripts/project-profile.test.mjs`) enforces this: it iterates every
profile on disk, and a meta test greps the engine sources for any product id and fails
with `file:line` on a hit. Onboarding a project is therefore adding a directory, not
editing the engine.

Canonical statement + onboarding runbook:
[`standards/agent-patterns/software-factory-v2.md` §8](../../standards/agent-patterns/software-factory-v2.md)
(§9 covers the cage posture). Read §8 before adding a project or touching `scripts/`.

## Layout

```
scripts/            # engine: board-*, verdict, ratify, metrics, git-autocommit, history,
                    #   claude-worker (the ONE external seat: Claude Code → z.ai/GLM, D-63),
                    #   cage-settings, probe-cage, probe-secrets
                    #   (+ *.test.mjs, + project-profile.test.mjs = the conformance suite)
scripts/lib/        # project.mjs — the path resolver (factoryRoot vs repoRoot) + profile loader
projects/<id>/      # THE PROJECT PROFILE — project.json, critical-files.json,
                    #   seat.env, validation.md (+ optional product-specific *.test.mjs)
skills/             # mission-plan | mission-build | mission-validate (Claude skills) — generic
templates/          # dossier templates + settings-external.json (the GENERIC cage base)
missions/<project>/ # per-project mission dossiers (spec of record, committed)
history.jsonl       # board history snapshots
decisions.md        # ratified factory decisions
constitution.md     # factory constitution
RUNBOOK.md          # operator runbook
deploy/             # projects.json (legacy manifest, back-compat) + DEPLOY-VPS.md + docker-compose
docs/               # harness research, cage research, plans
```

`deploy/projects.json` is the **legacy** manifest. It is still read for back-compat, but on
an id collision the `projects/<id>/project.json` entry wins. New projects use `projects/`.

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
