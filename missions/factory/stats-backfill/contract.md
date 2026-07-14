# Contract — stats-backfill

## Deliverable

`scripts/stats-backfill.mjs` — a thin, repeatable driver that walks mission dossiers
and fills missing `stats.json` via the EXISTING collector (`collect` is already
exported from `scripts/mission-stats.mjs:518` — import it, do NOT reimplement any
stat computation).

## CLI

```
node scripts/stats-backfill.mjs [--project <id>] [--all] [--force] [--missions <dir>]
```

- `--project <id>`: backfill one project's `missions/<id>/` (resolved via
  `resolveProject` from `scripts/lib/project.mjs`, house style).
- `--all`: every project directory under `missions/` (each subdir of `missions/` whose
  name matches a known profile id from `loadProjects`; unknown dirs are REPORTED as
  skipped, never processed).
- Default (no flag): behave as `--all`.
- `--force`: re-collect even when `stats.json` exists. Without it, existing files are
  NEVER touched (A1 below).
- `--missions <dir>`: override root for tests (hermetic fixtures).

## Behavior (assertions the tests must pin)

- A1 **No-clobber:** a dossier that already has `stats.json` is skipped without `--force`.
  *Mutation gate: remove the existsSync guard → a named test goes red.*
- A2 **Non-dossier entries skipped:** plain files under a project dir (e.g. a stray
  `*.handoff.md`) and dot-dirs are ignored, counted as neither total nor failure.
- A3 **Absent, never zero (E1-d law):** the driver passes through whatever `collect`
  yields — it must NOT default, zero-fill, or patch any field. If `collect` throws for
  a dossier, the driver records `{slug, error}` in its report, continues, and the
  dossier gets NO stats.json. *Mutation gate: make the catch write a zeros stats.json
  → named test red.*
- A4 **Coverage report:** stdout ends with one table line per project:
  `project=<id> dossiers=<n> had=<n> backfilled=<n> failed=<n>` plus a final
  `total: X/Y with stats`. Deterministic ordering (project id asc, slug asc).
- A5 **Exit codes:** 0 on any run that completes (even with per-dossier failures —
  it's a report tool); 2 on bad args/unknown --project.
- A6 **Pure core, thin shell** (house style, cf. `board-sync.mjs`): exported
  `planBackfill(rootDir, projects, opts)` (pure: returns {work, skipped}) and
  `runBackfill(plan, collectFn, emit)` (effects injected) so tests never touch git.

## Tests

`scripts/stats-backfill.test.mjs`, node:test + node:assert/strict, tmpdir fixtures
(mkdtempSync pattern used across this repo). Cover A1–A6 + `--force` + unknown project.
Inject a fake `collectFn` — never invoke real git in tests.

## Gate

`pnpm test` green from the worktree root. No product literals in `scripts/`
(meta-test `scripts/project-profile.test.mjs:370` enforces — use generic ids like
"alpha"/"beta" in fixtures). Small commits on branch `agent/stats-backfill`.

## Out of scope

- Running the backfill against real dossiers (coordinator, post-merge).
- Any change to `mission-stats.mjs`, `board-report.mjs`, or other files.
