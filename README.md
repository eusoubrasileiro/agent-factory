# @amiticia/factory

AmiticIA's software factory — the AI-agent mission engine (plan → build →
validate → ratify) plus the board renderers. It is the machinery that lets a
fleet of coding agents take a written mission brief, build it in isolated
worktrees, run a deterministic gate over the result, and hand a human one
decision: ratify or not. The published board at `factory.example.com` was retired
on 2026-09-16 (D-64); the renderers still run offline.

> **▶ Start here:** [`constitution.md`](constitution.md) — the standing rules
> every seat obeys, in about four minutes.

## Look at first

1. **[`constitution.md`](constitution.md)** — the whole contract in one short
   file: what an orchestrator, a worker and a validator may each do, and what
   none of them may do. It is broadcast to every seat and it almost never
   changes.
2. **[`decisions.md`](decisions.md)** — the ratified decision log, one appended
   line per decision, oldest first. Read **D-16**. It records the discovery that
   the permission cage — `cage-settings.mjs`, which renders a correct, audited
   Claude Code sandbox and had been reviewed as such — had **zero callers**. The
   dispatch script never installed it, its own header cited a driver that did not
   exist, and the driver that *did* run reads a different config schema
   entirely. So the file-protection, `git push` and SSH-key denials were never
   enforced, and the incident the cage was built to prevent was still possible
   the whole time. *A cage that is not installed costs zero productivity and buys
   zero security — it buys only the belief in security, which is worse than
   knowing you have no cage.* Nothing was broken; it had simply never worked.
3. **[`scripts/gate.mjs`](scripts/gate.mjs)** — the deterministic gate runner,
   and the reason D-16 is not the last word. It reports a **three-valued**
   verdict: `true`, `false`, or `null` for "the gate could not be run at all" —
   no commands declared, an unprovisioned worktree, a timeout, a signal kill,
   lock contention. `null` is deliberately never coerced to `false`, because a
   gate that cannot distinguish "failed" from "did not run" will eventually
   score an empty environment as a pass.

> **About this public export.** This is the real repository with its history
> kept, not squashed. Almost all of it was written by agents, and the commits say
> which one: **157 of the 186 commits at the point of export carried a
> `Co-Authored-By` trailer** naming the agent that made the change. That history
> is the point — it is the audit trail of a fleet of agents doing the work. (The
> count moves with every commit, including this note's own; re-derive it with
> `git rev-list --count HEAD` rather than trusting this line.)
> Client-facing material was removed rather than redacted, so a few things are
> deliberately absent: the client mission dossiers and their project profiles,
> the real `history.jsonl` run telemetry (a 20-row synthetic
> `history.sample.jsonl` with the identical schema ships in its place), and the
> host-specific VPS deploy runbook, and `decisions.inbox.md` (unratified
> proposals are not a published authority). Mission dossiers under `missions/` still
> reference those files where the work happened; the references are historical
> record, not broken links to fix. Tenant names appear as `tenant-a`, `tenant-b`,
> `tenant-c`.

> **Provenance.** The engine was extracted from a private product repository
> (internally `wahub`) at commit `97eaa40` on 2026-07-08, under the plan
> *Factory v2.1 — Factory Extraction*, Workstream 0/2. That product keeps its own
> quality contract (`quality-gate.mjs`, `quality-baseline.json`, `.husky` hooks,
> the PRD); the engine and all mission data live here. Mission dossiers still
> name `wahub` as the project they ran against — that is the historical record.

## The one architectural rule

**The engine knows the SHAPE of a project; only the profile knows the FACTS.**

Every per-project fact — gate commands, Critical Files, dummy-env shape, behavioral
validation — is **data** under `projects/<id>/`, never code under `scripts/`. A
conformance suite (`scripts/project-profile.test.mjs`) enforces this: it iterates every
profile on disk, and a meta test greps the engine sources for any product id and fails
with `file:line` on a hit. Onboarding a project is therefore adding a directory, not
editing the engine.

The canonical statement and the onboarding runbook live in the companion
`harness-standards` repository, at `agent-patterns/software-factory-v2.md` §8
(§9 covers the cage posture). Read §8 before adding a project or touching
`scripts/`.

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
pnpm install
pnpm test              # engine unit tests (node --test) — 1053 pass, 7 skipped, no network
pnpm board:report      # render one project's dashboard HTML
pnpm board:autopublish # render funnel; use --dry-run — the VPS target is gone (D-64)
pnpm board:publish     # rsync dist/factory-board/ to the VPS
pnpm mission:ratify    # ratify a validated mission
```

`pnpm test` is the one command that matters for a reader: it runs the whole
engine suite offline, with autopublish and PR creation guarded off, against the
synthetic `history.sample.jsonl`. Nothing in this repo needs a network, a VPS or
an API key to exercise.

## License

MIT — see [`LICENSE`](LICENSE).
