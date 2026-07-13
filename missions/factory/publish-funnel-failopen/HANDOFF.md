# Handoff — publish-funnel-failopen (builder seat)

Doctrine D-24/D-25: a check that cannot fail must never report success. All four
builder-seat fail-open defects (F1–F4) are fixed with strict Red→Green TDD — every
new test was run against the unfixed code first and confirmed red for the stated
reason before the minimal fix went in. F5 is a verification-only finding (already
fixed on `main` by D-32); no code change was needed.

`pnpm test` (`FACTORY_ROOT="$PWD" pnpm test`) exits 0: **632 tests, 625 pass, 7
skipped (pre-existing, unrelated), 0 fail.** Baseline before this mission was 625
tests / 618 pass — this mission added 7 new tests, deleted/weakened none (contract
assertion A7).

## F1 (A1, E1-b) — `board-sync.mjs` `makeBacklog` ignored non-zero exit

**File:** `scripts/board-sync.mjs:202-214` (`makeBacklog`)
**Fix:** `makeBacklog`'s closure now throws `Error(backlog <args> exited <status>: <stderr|stdout>)`
when `r.status !== 0`, not just on `r.error`. A failed `backlog task list` used to read
as empty stdout → every mission looked new → duplicate `task create` calls, and a failed
`create`/`edit` still exited 0.
**New test:** `scripts/board-sync.test.mjs` — `"sync aborts (non-zero exit) and creates
ZERO cards when \`task list\` fails (F1)"`. Stubs `BACKLOG_BIN` (a Node script forwarding
everything to the real `backlog` binary via `REAL_BACKLOG_BIN`, except `task list`, which
it fails).
**Red→green:** pre-fix, the test failed with `actual: 0, expected: 0` on `assert.notEqual`
— i.e. sync exited 0 and had already created the card (`stdout: "one: (new) -> Planning"`).
Post-fix: sync exits non-zero, zero cards created.

## F2 (A2, E1-c) — `board-import-backlog.mjs` unchecked `task list` read

**File:** `scripts/board-import-backlog.mjs:177-189` (`makeBacklog`, mirrors F1's fix)
and `:201-251` (`importRows`, now wraps both the `task list` read and the `task create`
call in try/catch, returning `{ error }` on either).
**Fix:** same throw-on-non-zero hardening as F1 applied to this file's own `makeBacklog`
copy; `importRows` now catches that throw at both call sites instead of only checking
`r.status` after `task create` (the `task list` read had no check at all).
**New test:** `scripts/board-import-backlog.test.mjs` — `"import aborts (non-zero exit)
and creates ZERO cards when \`task list\` fails (F2)"`, same stub pattern as F1.
**Red→green:** pre-fix, the test failed on `assert.notEqual(r.status, 0, ...)` — the
import had exited 0 and created all 18 fixture cards despite the stubbed list failure.
Post-fix: import exits non-zero, zero cards created.

## F3 (A5, E1-d) — `mission-stats.mjs` wrote authoritative zeros on a transient git failure

**File:** `scripts/mission-stats.mjs:557-565` (new `partial: false` default field on
`stats`) and `:566-598` (the git-diff block in `collect()`).
**Fix:** `collect()` now distinguishes "git ran, no change" from "git failed". Once
`resolveRange` succeeds, if the subsequent `git diff --numstat` or `git diff` call
returns `null` (the `git()` wrapper's total-failure sentinel), `stats.partial = true`
is stamped and `stats.loc`/`stats.testsAdded` are left `null` instead of the zeroed
`parseNumstat(null)`/`countTestsAdded(null)` result — indistinguishable, pre-fix, from
"the mission truly changed nothing". `board-report.mjs:808` and `history.mjs:114`
already tolerate `null` loc gracefully (`if (stats.loc && typeof stats.loc ===
"object")` / `stats?.loc ?? null`), so no renderer changes were needed. The
"no branch resolved yet" path (`resolveRange` returns `null`) is untouched and still
yields the legitimate zeroed `stats.json` (mission hasn't started).
**New tests:** `scripts/mission-stats.test.mjs` —
  - `"collect stamps partial=true and does not report a fake zero LOC when git diff
    fails post-resolveRange (F3)"`: builds a real tmp git repo with a resolvable
    `agent/<slug>` branch, then PATH-shims `git` to fail only on `git diff`
    (forwarding `rev-parse`/`merge-base`/`log`/`show` to the real binary so
    `resolveRange` genuinely succeeds first).
  - `"collect does NOT set partial on the normal all-clean happy path"` — pins the
    non-regression side of the fix.
**Red→green:** pre-fix, the first test failed with `actual: undefined, expected:
true` on `res.stats.partial` — the stats object had no `partial` field and would have
reported `loc: {added:0,deleted:0,files:0}` as if nothing changed.

## F4 (A6, E1-f) — `board-autopublish.mjs` double-fires with no serialization

**File:** `scripts/board-autopublish.mjs:344-401` (new `acquireLock`/`releaseLock`,
`LOCK_STALE_MS = 120_000`) and `:461-485` (`run()` now acquires/releases the lock
around a new `runLocked()`, which holds the rest of the original `run()` body
unchanged).
**Fix:** an advisory lockfile at `dist/factory-board/.lock`, opened with
`fs.openSync(path, "wx")` (`O_EXCL`). A run that finds a live lock backs off — logs
one line, exits 0, touches nothing else — instead of racing the render+publish+append
critical section. A lock older than 120s is treated as an abandoned/crashed prior run
and reclaimed (unlink + re-open). Both autopublish triggers (verdict/ratify's
`triggerAutopublish()` and the post-commit hook) are untouched — only the critical
section they can both enter is now serialized. Lock acquire/release never throws, so
a lock failure degrades to "could not acquire" (best-effort, same as the rest of the
funnel) rather than breaking a verdict.
**New tests:** `scripts/board-autopublish.test.mjs` —
  - `"lock: a live (fresh) lock file makes the run back off — no render side effects
    (F4)"` — deterministic, pre-creates `.lock`, asserts no history/hash/render
    side effects and the other holder's lock file is left alone.
  - `"lock: a stale (>120s) lock file is reclaimed and the run proceeds normally
    (F4)"` — deterministic, backdates `.lock`'s mtime via `utimesSync`, asserts a
    normal publish occurs and the lock is released afterward.
  - `"lock: two concurrent autopublish runs append exactly ONE history snapshot set
    (F4)"` — the literal assertion A6 asks for: two CLI invocations launched via
    async `spawn()` + `Promise.all` (genuine OS-level concurrency, not
    `spawnSync`), asserting a single `demo` row lands in `history.jsonl`.
**Red→green — important caveat for the validator:** the two *deterministic* tests
(live-lock backoff, stale-lock reclaim) failed reliably against the unfixed code
(`actual: true, expected: false` — history/lock state that shouldn't have existed,
did). The *concurrency* test, however, **passed even before the fix** — verified
empirically across 5 repeated runs both pre- and post-fix. Two async-spawned child
processes against this small fixture apparently serialize naturally often enough
(process-spawn/module-load scheduling latency) that the pre-existing hash guard
alone masks the race in this harness, even though the underlying defect (E1-f) is
real per the contract's own diagnosis. **The two deterministic tests are what
actually enforces the mutation gate for E1-f** (`remove the lockfile → A6 red`) —
they go red the instant `acquireLock`/`releaseLock` are removed or bypassed; the
concurrency test is a real integration exercise of both triggers racing but is not,
by itself, an adversarially reliable proof.

## F5 (E1-a) — regression-only, verified not re-implemented

Per contract: "E1-a is already FIXED on main (D-32)... verify a regression test
pins it... add one if missing." Checked `scripts/board-autopublish.test.mjs` —
the test `"publish guard: source pins the rsync preconditions and the status
check"` (source-text assertions on `published = !r.error && r.status === 0;` and
that the `"rsync falhou"` branch returns before `writeFileSync(memoPath, hash)`)
already exists and pins exactly this: a failed rsync leaves the `.hash` memo
unchanged so the next run retries. It predates this mission (not authored here).
**No new test added** — it would have to be source-level too: `run()`'s real-publish
branch only executes when `path.resolve(repoRoot) === ROOT` (the actual factory
checkout), by design (see the "Who is allowed to touch the live board" comment in
`board-autopublish.mjs`), specifically to stop tests from rsyncing a fixture over
the live board. Driving that branch behaviorally would require pointing a test at
the real `ROOT`, which would pollute the real `dist/factory-board/` and
`history.jsonl` — the exact incident (2026-07-09) D-32 and the surrounding guard
exist to prevent. The existing source-pin test is the intentional, safe substitute.

## Hard constraints honored

- Did not touch `metrics.mjs`, `verdict.mjs`, `ratify.mjs`, `cage-settings.mjs`,
  `lib/project.mjs`, `templates/**`, `projects/**`, `constitution.md`,
  `decisions.md` (cage-denied to this seat).
- No dependency outside `node:*`. Every touched script kept its header comment,
  `isMain` guard, and soft-fail semantics.
- All new tests landed in the existing `*.test.mjs` files already covered by the
  `pnpm test` glob.

## Commits on `agent/publish-funnel-failopen`

1. `fix(factory): F1 — board-sync makeBacklog throws on non-zero backlog exit`
2. `fix(factory): F2 — board-import-backlog aborts on failed task list read`
3. `fix(factory): F3 — mission-stats stamps partial=true on a transient git-diff failure`
4. `fix(factory): F4 — board-autopublish serializes render+publish+append with an advisory lock`
