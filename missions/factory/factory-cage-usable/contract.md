# Validation Contract — factory-cage-usable

> Author: orchestrator (coordinator). Reader: the held-out validator.
> Written BEFORE any code. The validator gets ONLY this file and the mission diff.

## Definition of done

The containment the factory claims is the containment it enforces, **for the driver it
actually runs**. A timed-out worker gets a chance to flush before it dies. Every deny
class is proven on filesystem ground truth, not on the harness's self-report.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| B1 | `killGracefully(child, {graceMs})` sends SIGTERM, resolves `{escalated:false}` if the child exits within the grace window, and escalates to SIGKILL otherwise | `scripts/lib/worker-common.test.mjs` — real child processes, not mocks |
| B2 | `killGracefully` never throws on an already-exited child, and leaves no dangling timer (the test process exits on its own) | same |
| B3 | `opencode-worker.mjs` no longer sends a bare `SIGKILL` at timeout; it calls `killGracefully`. `timedOut` semantics and the `exitCode: timedOut ? 1 : code` mapping are unchanged | grep + `scripts/opencode-worker.test.mjs` unmodified and green |
| B4 | `renderOpencodeCage({criticalFiles})` emits `permission.edit` and `permission.bash` with `"*"` as the FIRST key of each (opencode: last matching rule wins — order is load-bearing) | `scripts/cage-opencode.test.mjs` |
| B5 | Every glob in a profile's `critical-files.json` appears as an `edit` deny; `git push *` appears as a `bash` deny | same |
| B6 | The opencode cage denies edits to its own config (`opencode.json`, `.opencode/**`, `AGENTS.md`) — self-protection, since a project `opencode.json` outranks `$OPENCODE_CONFIG` | same |
| B7 | `auditOpencodeCage` rejects a cage whose first key is not `"*"`, whose self-protect entries are missing, or whose values are not `allow`/`deny`/`ask`; `writeOpencodeCage` REFUSES to write an audit-dirty cage (throws) | same |
| B8 | With no project, `renderOpencodeCage()` emits the generic base and **zero** product paths | same |
| B9 | `opencode-worker.mjs` writes a fresh cage before every spawn and passes it via `OPENCODE_CONFIG` on the child env, WITHOUT widening `SPAWN_ENV_ALLOWLIST` | `scripts/opencode-worker.test.mjs` + grep |
| B10 | `probe-cage.mjs` exercises ≥ 4 deny classes and asserts each on **filesystem ground truth** (file hash / file existence / git ref), never on `permission_denials` | read the probe; run it |
| B11 | `probe-cage.mjs` exits non-zero if ANY deny class is breached, and exits 0 with a transcript when all hold | run it |
| B12 | The engine still carries zero product literals, and the conformance suite still passes for all three profiles | `pnpm test`; `scripts/project-profile.test.mjs` |
| B13 | Test count GREW; no assertion deleted | compare totals vs baseline 400 tests / 394 pass / 6 skip (in-worktree) |

## Explicitly NOT in this mission (state it, so silence is not mistaken for coverage)

- `claude-worker.mjs` and Tier A/B machine gating. They serve the **deferred** opencode-vs-caged-CC
  A/B, whose spend is Andre's call. Building them now would gate a consumer that does not exist.
  The Claude Code cage (`cage-settings.mjs`) therefore REMAINS uninstalled after this mission,
  and that is a known, recorded state — not an oversight.
- Egress control. Under Tier A the seat still has open network access.

## House-standard gate

- `pnpm test` from the factory root exits 0.
- No dependency outside `node:*`.
- Every new script keeps the `isMain` pattern (via `lib/is-main.mjs`), a header comment with
  Usage + exit codes, and soft-fail semantics for side channels.

## Robustness

- A profile with no `critical-files.json` renders the generic base, never throws.
- A worker spawned with no `--project` still gets the generic base cage (git-push deny +
  self-protect), never an empty `permission` block.
- `probe-cage.mjs` must restore anything it plants, and must say so loudly if it cannot.

## Verdict

Passes only when every assertion is green and `pnpm test` exits 0, proven locally.
A green B10/B11 that asserts on `permission_denials` rather than the filesystem is a **FAIL**,
regardless of what it prints.
