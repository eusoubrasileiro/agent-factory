# Contract — scrumban-board

> Author: orchestrator (before code). Reader: held-out validator. The validator proves
> every assertion against the LOCAL worktree; it never reads worker code commentary.

## Definition of done

Backlog.md is installed as a one-way live dashboard of `factory/missions/*` state:
columns derive purely from on-disk signals, PASS never auto-completes a card, the layer
is removable without breaking the factory, and the legacy `Situação` column is retired.

## Assertions

| id | Assertion | Proof mechanism |
|----|-----------|-----------------|
| A1 | `backlog/config.yml` (or `backlog config get statuses`) lists exactly, in order: `Intake, Planning, Building, Validating, Needs Human, Done, Blocked`; default status `Intake`. | read config / CLI in worktree |
| A2 | `pnpm board:sync` creates/updates one card per `factory/missions/<slug>/` in the derived column. Spot-check three real missions: `sdr-nonlead-gate` (brief.md only) → `Planning`; `crm-dashboard-data` (validate.log last verdict PASS, no RATIFIED) → `Needs Human` + label `gate:ratify`; `profile-pic-saas` (no brief.md) → `Intake`. | run `pnpm board:sync`, then `backlog task list --plain` |
| A3 | In a temp fixture (own `backlog/` + missions root): piping a synthetic PASS verdict through `node scripts/factory/verdict.mjs record <slug> --dir <tmp>` moves the card to `Needs Human` with `gate:ratify` — **NEVER `Done`**. Three sequential FAIL rounds → card in `Needs Human` with `gate:escalated`; a FAIL at round < 3 leaves it `Validating`. | scripted temp-dir run |
| A4 | Drift repair: manually `backlog task edit <id> -s "Done"` on a card whose disk state derives `Planning`, run `pnpm board:sync` → card back to `Planning`. board-sync edits ONLY cards whose derived status differs (idempotent: second run emits no edits). | CLI + rerun |
| A5 | Soft layer: with `backlog/` renamed away, `node scripts/factory/verdict.mjs record` on a fixture mission still exits 0 and appends the verdict line; `pnpm quality-gate` and `pnpm test` still pass. Restore afterwards. | rename, run, restore |
| A6 | `node scripts/factory/board-import-backlog.mjs` seeds exactly 18 cards (A1–A5, B1–B4, C1–C6, D1–D3) from `docs/prd/nexus-build-backlog.md` with labels `body:<A\|B\|C\|D>` and `risk:<low\|med\|high>`; normalization: A2 (`**done** (crm-inbox + overlay)`) → `Done`; B1 (`todo`) → `Intake`; A1 (`parcial — …`) and A4 (`verificar (…)`) → `Intake` + label `needs-verify`. Re-running creates zero duplicates. The doc's `Situação` column carries a deprecation banner pointing to `pnpm board`. | run importer twice, list cards, read doc |
| A7 | `pnpm mission:ratify <slug>` writes `factory/missions/<slug>/RATIFIED` and the card derives `Done`. A `BLOCKED` marker derives `Blocked`. | temp fixture |
| A8 | WIP warnings: with a fixture missions root deriving 6 `Needs Human` cards, board-sync prints a warning mentioning the limit (5) but still syncs (exit 0). | temp fixture |
| GATE | `pnpm test`, `pnpm --filter=@wahub/backend exec tsc --noEmit`, `pnpm --filter=@wahub/frontend exec tsc --noEmit`, `pnpm lint`, `pnpm quality-gate`, and `pnpm test:factory` all exit 0. Diff touches NO product code (`backend/src`, `frontend/src`, `shared/src`, `prisma/`) and no Critical File other than the four `SKILL.md` files named in scope. `scripts/factory/verdict.test.mjs` passes UNMODIFIED (additive test files allowed). | house gate in worktree |

## Robustness

- board-sync on a mission dir with unexpected contents (e.g. only `RESEARCH.md`) must not
  throw — derives `Intake`.
- verdict.mjs hook failure paths (no `backlog/`, board-sync crash) never change verdict.mjs
  output lines already specified, nor its exit code.

## Verdict

Emit via `echo "$VERDICT_JSON" | node scripts/factory/verdict.mjs record scrumban-board`
(schema in the file). PASS requires every assertion green.
