# Validation Contract — cost-cli-polish

> Author: orchestrator (coordinator). Reader: the held-out validator.
> Written BEFORE any code. The validator gets ONLY this file and the mission diff.

## Definition of done

Negative dollar amounts read correctly (`-$X.XX`) everywhere the factory prints money,
and the two cost rollups (`spend.mjs`, `history.mjs`) agree that a zero plan fee means
"no plan basis" (`null`), not `$0`. Nothing else changes: no card, column, sentinel, or
number that was correct before is altered.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 | `spend.mjs` `fmtUsd(-59.5) === "-$59.50"` and `fmtUsd(-0.5) === "-$0.50"` (sign before `$`) | `scripts/spend.test.mjs` — new cases |
| A2 | `spend.mjs` `fmtUsd` is unchanged for non-negative and null inputs: `fmtUsd(0) === "$0.00"`, `fmtUsd(12.3) === "$12.30"`, `fmtUsd(null) === "—"` | same |
| A3 | `board-report.mjs` `fmtUsd(-59.5) === "-$59.50"`; and unchanged otherwise: `fmtUsd(0) === "$0.00"`, `fmtUsd(null) === "sem dados"`, `fmtUsd(NaN) === "sem dados"` | `scripts/board-report.test.mjs` — new cases (export `fmtUsd` if not already exported) |
| A4 | `history.aggregate(rows, { planFeeUsd: 0, … })` yields `planTotal === null` (and therefore `savings === null`), matching `spend.mjs`'s falsy-zero semantics | `scripts/history.test.mjs` — new case |
| A5 | `history.aggregate` is unchanged for a real fee: with `planFeeUsd: 72` and ≥1 safe snapshot, `planTotal === 72` as before | same / existing cases stay green |
| A6 | The full suite grew (new assertions added) and **no existing assertion was deleted or weakened** | `pnpm test`; compare test totals against the pre-mission baseline |

## Explicitly NOT in this mission

- `board-autopublish.mjs` FACTORY_ROOT resolution from inside an engine worktree. Known,
  recorded; a separate mission. Silence here is not coverage.
- Any change to the recorded numbers themselves, the seat recorders, or `pricing.mjs`.

## House-standard gate

- `pnpm test` from the factory root exits 0.
- No dependency outside `node:*`.
- `node:test` + `node:assert/strict`. **Not vitest.** New test cases live in the existing
  test files (already inside the `pnpm test` globs).
- Every touched script keeps its header comment, `isMain` guard, and soft-fail semantics.

## Robustness

- `fmtUsd` must not throw on `-0`, and `-0` must not render `"-$0.00"` with a spurious
  sign (treat `-0` as `0` → `"$0.00"`). State the choice in the test.

## Verdict

Passes only when every assertion A1–A6 is green and `pnpm test` exits 0, proven locally.
A "fix" that changes the null sentinel of either `fmtUsd` (`"—"` for spend, `"sem dados"`
for board) is a **FAIL** — the sentinels differ by design and must be preserved.
