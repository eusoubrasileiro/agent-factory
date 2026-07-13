# Validation Contract — publish-funnel-failopen

> Author: orchestrator (coordinator, Opus). Reader: the held-out validator.
> Written BEFORE any code. The validator gets ONLY this file and the mission diff.
> Doctrine: D-24/D-25 — *a check that cannot fail must never report success.*

## Definition of done

The published board and the KPI meter can no longer silently lie. Every funnel step
that today swallows a failure — a non-zero `backlog` exit read as success, a corrupt
JSONL line crashing a reader, a transient `git` failure stamped as an authoritative
all-zeros `stats.json`, two concurrent autopublish runs racing the hash guard — either
fails loudly or degrades to an honest "no data" marker. No legitimate green path is
made slower or stricter; the redundant autopublish triggers are preserved by design.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 (E1-b) | `makeBacklog` treats a non-zero exit as failure: a stubbed `backlog` CLI exiting 1 on `task list` makes `board-sync` exit non-zero and create **zero** cards (no duplicate-card path) | `scripts/board-sync.test.mjs` — new test with a stub `BACKLOG_BIN` exiting 1 |
| A2 (E1-c) | `board-import-backlog` builds `existingTitles` from a **checked** `task list`: a stubbed failing list makes it exit non-zero and import nothing, rather than treating the list as empty and re-creating cards | `scripts/board-import-backlog.test.mjs` — new test |
| A3 (E1-e) | `metrics.mjs` `readRecords` tolerates one corrupt JSONL line — skips it, never throws — so `metrics summary` still prints | `scripts/metrics.test.mjs` — new corrupt-line test |
| A4 (E1-e) | `verdict.mjs` `readRecords` tolerates one corrupt JSONL line — skips it, never throws — so `verdict status` still prints | `scripts/verdict.test.mjs` — new corrupt-line test |
| A5 (E1-d) | `mission-stats` distinguishes "git ran, no change" from "git failed": when `resolveRange` succeeded but a `git diff` returned null, the written `stats.json` carries `"partial": true` and does **not** report a zeroed `loc`/`testsAdded` as authoritative | `scripts/mission-stats.test.mjs` — new test stubbing a git-diff failure |
| A6 (E1-f) | Two concurrent autopublish runs append exactly **one** history snapshot set (advisory lockfile serializes render+publish+append); neither trigger is removed | `scripts/board-autopublish.test.mjs` — new concurrency test |
| A7 | The full suite grew (new assertions added) and **no existing assertion was deleted or weakened** | `pnpm test`; compare test totals against the pre-mission baseline (623) |

## Mutation gate (each fix must fail a NAMED test when weakened)

- E1-b: restore `makeBacklog` to `if (r.error) throw` only (drop the status check) → A1 red.
- E1-c: restore the unchecked `task list` read → A2 red.
- E1-e: restore the bare `.map((line) => JSON.parse(line))` in either reader → A3/A4 red.
- E1-d: restore the unconditional zeros write (no `partial` marker) → A5 red.
- E1-f: remove the lockfile → A6 red (double snapshot appears).

## Seats

- **[coordinator-seat]** `metrics.mjs`, `verdict.mjs` (A3/A4) — authored by the coordinator;
  the cage denies these to the builder.
- **[builder-seat]** `board-sync.mjs` (A1), `board-import-backlog.mjs` (A2),
  `mission-stats.mjs` (A5), `board-autopublish.mjs` (A6) + all their tests.

## Explicitly NOT in this mission

- E1-a is already FIXED on main (D-32). This mission only VERIFIES a regression test pins
  it (stubbed failing publish → hash memo unchanged, next run re-attempts); add one if missing.
- No change to the recorded numbers, seat recorders, or `pricing.mjs`.
- The `board-autopublish` FACTORY_ROOT-from-engine-worktree resolution stays parked (E4).

## House-standard gate

- `pnpm test` from the factory root exits 0 (run `FACTORY_ROOT=<main checkout> pnpm test`
  from an engine worktree — RUNBOOK caveat).
- No dependency outside `node:*`. `node:test` + `node:assert/strict`. **Not vitest.**
- Every touched script keeps its header comment, `isMain` guard, and soft-fail semantics.

## Verdict

Passes only when A1–A7 are green and `pnpm test` exits 0, proven locally, **and** each
mutation above turns its named test red. A guard that stays green after being weakened is
hollow = FAIL. Autopublish must remain **best-effort** — a publish failure still exits 0
(D-32); only the *lie* (memo/stats/board claiming success that did not happen) is the defect.
