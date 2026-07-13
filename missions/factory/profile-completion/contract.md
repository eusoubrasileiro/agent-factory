# Validation Contract — profile-completion

> Author: orchestrator (coordinator, Opus). Reader: the held-out validator.
> Written BEFORE code. Goal (business): onboard project #3 with **zero engine edits**.
> Doctrine D-15: the engine knows a project's SHAPE; only the profile knows its FACTS.

## Definition of done

The three engine seams that still bake in one product's facts are moved to the profile:
a project's worktree layout, its board presence, and its backlog source. A profile-only
project (no `deploy/projects.json` row) appears on the published board and can be dispatched,
imported, and titled without touching a `scripts/` file.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 (E4-a) | `worktreeMarker` is read from `projects/<id>/project.json` (default `/.claude/worktrees/`); the `FACTORY_WORKTREE_MARKER` env fallback is deleted; both drivers refuse a worktree that doesn't match the profile's marker | `claude-worker.test.mjs` / `opencode-worker.test.mjs` — marker from profile; conformance test pins the field |
| A2 (E4-b) | a `projects/`-only project (e.g. `factory`, `tenant-c`) appears in `board-autopublish` output and the root index — both route through `loadProjects()`, not a raw `deploy/projects.json` read | `board-autopublish.test.mjs` / `board-index.test.mjs` — profile-only project present |
| A3 (E4-c) | `board-import-backlog --project <id>` resolves the PRD via `resolveProject({project})`; with no `prd` in the profile it imports nothing (no wahub `nexus-build-backlog.md` fallback) | `board-import-backlog.test.mjs` — `--project` routing + no-prd → 0 import |
| A4 (E4-d) | the board title is neutral (`AmiticIA Factory`, or a `board.title` profile field), not `Fábrica Nexus`, on every project's landing page | `board-report.test.mjs` / `board-index.test.mjs` title assertions |
| A5 | the conformance suite iterates every profile and pins the new fields (`worktreeMarker` present-or-defaulted; profile-only project appears in the autopublish project list) | conformance/project tests |
| A6 | no assertion deleted/weakened; full suite green | `pnpm test` vs baseline |

## Mutation gate
- E4-a: restore the `FACTORY_WORKTREE_MARKER ??` env fallback → the "marker from profile" test red.
- E4-b: revert board-autopublish to the raw `deploy/projects.json` read → the profile-only-project test red.
- E4-c: restore the wahub PRD fallback → the no-prd-imports-nothing test red.

## Seats
- **[coordinator-seat]** `scripts/lib/project.mjs`, `projects/**` (worktreeMarker field + loader).
- **[builder or coordinator]** `claude-worker.mjs`/`opencode-worker.mjs` (read marker from profile),
  `board-autopublish.mjs`/`board-index.mjs`/`board-import-backlog.mjs`/`board-report.mjs` + tests.

## Explicitly NOT in scope
- E4-e (ship `templates/dispatch-worktree.sh` parameterized) is the LAST feature and optional
  if time-boxed — a bigger, standalone change; deferred, noted, not silently dropped.

## House-standard gate
`pnpm test` exits 0; `node:test`/`node:assert/strict`; no dep outside `node:*`; headers/isMain kept.

## Verdict
Passes when A1–A6 green and `pnpm test` exits 0, proven locally, each mutation turns its named
test red. The real proof is the auditor's walk: a profile-only project (tenant-c) dispatches,
gates, and appears in `board-autopublish --dry-run` with zero engine edits and zero env overrides.
