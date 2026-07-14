# Validation Contract — factory-live-board

> **Reader: the held-out validator.** Prove every assertion against LOCAL disk with the
> stated mechanism. Behavior, not intent. An assertion without a green proof FAILS.
> VPS restructuring is orchestrator-manual and NOT part of this contract.

## Assertions

| ID | Assertion | Proof mechanism |
|----|-----------|-----------------|
| A1 | Fast-path guard: a commit staging ONLY files under `factory/missions/**` (and/or `factory/history.jsonl`) skips lint-staged/tsc/tests (completes in <10s) but still passes commitlint; a commit staging any file under `backend/src/**` runs the FULL pre-commit gate (guard does not leak). | Two real commits in a throwaway branch of the worktree; time them; inspect `.husky/pre-commit` guard logic; revert the commits. |
| A2 | `node scripts/factory/board-autopublish.mjs --dry-run` exits 0 with NO network access; renders every project in `deploy/factory-board/projects.json`; prints the rsync invocation targeting `deploy-host:/opt/app/factory/public/`; run twice back-to-back → second run reports "sem mudanças" (hash guard) and appends NOTHING to `factory/history.jsonl`; a state change (touch a fixture mission marker) → exactly one new snapshot row per mission. | Run offline; diff history.jsonl line counts between runs. |
| A3 | Recursion/loop safety: `board-autopublish.mjs` never executes a git write command (`commit`, `add`, `push`, `merge`) — grep the source; `git log` after a full autopublish run shows zero new commits made by it. | grep + git log before/after. |
| A4 | `verdict.mjs record` on a fixture mission writes a validate.log line containing an ISO-8601 `ts` field, then creates a `chore(factory)` commit whose diff touches ONLY files under `factory/missions/<slug>/` (plus optionally `factory/history.jsonl`), and `.publish.log` gains an autopublish invocation line. Ratify behaves the same for `RATIFIED`. | Fixture mission in the worktree; run; inspect git show + logs; revert. |
| A5 | Per-project output: `board-autopublish.mjs --dry-run` writes `dist/factory-board/index.html` (root project index: one card per projects.json entry, self-contained — zero external `http(s)://` resource loads), `dist/factory-board/wahub/index.html` (the full dashboard — all 18 requirement IDs A1–A5/B1–B4/C1–C6/D1–D3 present, each with missão or "sem missão"), and `dist/factory-board/scrumban/index.html` (redirect to `/wahub/`). | Run; grep all three outputs. |
| A6 | History rendering: a tmp-dir fixture history.jsonl with ≥3 snapshots across ≥2 missions (one reaching Done) renders a Histórico tab showing lead time, rondas do validador, missões/semana, and atenção-por-feature; with NO history.jsonl and NO metrics.jsonl the tab renders "sem dados" without crashing. | Fixture through the renderer (pure core or CLI with overrides); grep output HTML. |
| A7 | Portability flags: `board-report.mjs` honors `--branch-prefix` and `--trunk` (fixture git repo with a `x/foo` branch off `develop` joins mission `foo`); defaults remain `agent/` + `main`. | Tmp fixture git repo; run with flags. |
| GATE | `pnpm test` · `pnpm test:factory` · `pnpm --filter=@wahub/backend exec tsc --noEmit` · `pnpm --filter=@wahub/frontend exec tsc --noEmit` · `pnpm lint` · `pnpm quality-gate` — all exit 0. | Run each. (`pnpm lint` "possibly out of memory" = intermittent flake, retry once.) |

## Non-negotiable invariants
1. `board-autopublish.mjs` is git-write-free (A3) — it only writes `dist/**`,
   `factory/.publish.log`, and appends to `factory/history.jsonl`.
2. The 18-requirement dashboard assertions from the factory-dashboard mission contract
   still hold on `/wahub/index.html` (A5 covers the core; nothing regresses).
3. No secret, htpasswd hash, or `.env` content appears anywhere in `git diff main...HEAD`.
