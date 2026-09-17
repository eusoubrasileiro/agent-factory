# @amiticia/factory

AmiticIA's software factory — the AI-agent mission engine (plan → build →
validate → ratify) plus the board renderers. The published board at
`factory.example.com` was retired on 2026-09-16 (D-64); the renderers still run offline.

> **▶ Start here:** [`RUNBOOK.md`](RUNBOOK.md) to operate it,
> [`constitution.md`](constitution.md) for the rules every seat obeys,
> [`decisions.md`](decisions.md) for why anything is the way it is.

> **About this public export.** This is the real repository with its full commit
> history — 184 commits, agent-authored, `Co-Authored-By` trailers intact. That
> history is the point: it is the audit trail of a fleet of agents doing the work.
> Client-facing material was removed rather than redacted, so a few things are
> deliberately absent: the client mission dossiers and their project profiles,
> the real `history.jsonl` run telemetry (a 20-row synthetic
> `history.sample.jsonl` with the identical schema ships in its place), and the
> host-specific VPS deploy runbook. Mission dossiers under `missions/` still
> reference those files where the work happened; the references are historical
> record, not broken links to fix. Tenant names appear as `tenant-a`, `tenant-b`,
> `tenant-c`.

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
history.sample.jsonl # board history snapshots — SYNTHETIC sample (see note below)
decisions.md        # ratified factory decisions
constitution.md     # factory constitution
RUNBOOK.md          # operator runbook
deploy/             # projects.json (legacy manifest, back-compat)
docs/               # harness research, cage research, plans
```

`deploy/projects.json` is the **legacy** manifest. It is still read for back-compat, but on
an id collision the `projects/<id>/project.json` entry wins. New projects use `projects/`.

## Two roots (the one design rule)

Path resolution goes through `scripts/lib/project.mjs` → `resolveProject()`:

- **factoryRoot** — this repo. Holds `missions/<project>/<slug>/`,
  `history.jsonl`, `.publish.log`, `deploy/projects.json`, `dist/factory-board/`.
  In this public export `history.jsonl` is absent: it held real run telemetry. A
  20-row synthetic `history.sample.jsonl` with the identical schema ships instead,
  so every consumer (`scripts/history.mjs`, `board-report.mjs --history`) still runs.
  Point them at it with `--history history.sample.jsonl`.
  Dossier auto-commits land here.
- **repoRoot** — the product repo (`deploy/projects.json` `path`, e.g.
  `../../products/<id>`). Holds the code workers edit, the `agent/*` branches
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
pnpm board:autopublish # render funnel; use --dry-run — the VPS target is gone (D-64)
pnpm board:publish     # rsync dist/factory-board/ to the VPS
pnpm mission:ratify    # ratify a validated mission
```
