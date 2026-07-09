# Validation Contract — factory-profiles

> Author: orchestrator (coordinator). Reader: the held-out validator.
> Written before any code. The validator gets ONLY this file and the mission diff.

## Definition of done

The factory engine contains no product-specific literals. Every per-project fact
(gate commands, critical files, dummy env, behavioral validation playbook) lives in
`projects/<id>/`, is loaded through `resolveProject`, and is enforced by a
conformance suite that iterates every profile on disk. The wahub loop still works
exactly as before — same dispatch, same dummy env, same cage rules.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 | `projects/wahub/` holds `project.json`, `critical-files.json`, `seat.env`, `validation.md`, and `templates/external-seat.env` no longer exists | `test -f` on each; `test ! -e templates/external-seat.env` |
| A2 | `resolveProject({project:"wahub"})` returns a `profile` block with non-empty `gate[]`, the 12 `criticalFiles`, and absolute `seatEnvPath`/`validationPath` | `scripts/project-resolver.test.mjs` |
| A3 | `resolveProject` is TOTAL: unknown id, missing profile, and corrupt `project.json` each yield synthesized defaults and never throw | `scripts/project-resolver.test.mjs` |
| A4 | No `"wahub"` literal fallback survives in the resolver — an unknown id resolves as itself, not as wahub | `scripts/project-resolver.test.mjs` |
| A5 | `node scripts/cage-settings.mjs print <wt> --project wahub` emits every wahub critical glob as BOTH `Edit(//…)` and `Write(//…)` rules, and the result is audit-clean | acceptance command in `plan.md` §Acceptance |
| A6 | The base template `templates/settings-external.json` contains zero product paths | `scripts/cage-settings.test.mjs` |
| A7 | The `.claude/**` regression pin still holds (no wholesale deny) and all pre-existing generic cage invariants (anchoring trap, unsubstituted placeholder, fail-closed audit, settings self-protection) still pass | `scripts/cage-settings.test.mjs` — pre-existing tests unmodified |
| A8 | A conformance suite iterates EVERY directory under `projects/` and fails on a missing required file, an empty `gate[]`, a cage-audit-dirty critical-files list, or a real-looking secret in `seat.env` | `scripts/project-profile.test.mjs` |
| A9 | `grep -rn "wahub" scripts/ templates/ skills/` returns zero lines | acceptance command; also asserted in-process by the conformance suite's meta test |
| A10 | wahub's `dispatch-worktree.sh --seat external` still renders a dummy-env worktree from the NEW profile path, and `probe-secrets.mjs` finds zero real-secret hits | acceptance run in `plan.md` §Acceptance |
| A11 | `board-index.mjs` output is byte-identical to before when wahub is the sole manifest entry (redirect default now derived, not hardcoded) | `scripts/board-index.test.mjs` |
| A12 | Test count GREW: no test was deleted, only moved (the wahub-critical-file assertion moved from `cage-settings.test.mjs` into the conformance suite) | compare `pnpm test` totals vs baseline 348/346-pass/2-skip |

## Amendment 1 — A11 (coordinator, 2026-07-09, AFTER code, BEFORE validation)

**A11 as written is unprovable, and the reason is a defect it failed to catch.**

A11 says the board output must be "byte-identical to before **when wahub is the sole
manifest entry**." That premise died inside this very mission: F6 adds the `factory`
dogfood profile, so there are now two entries. The assertion was authored against a
world the mission's own plan had already scheduled to end.

Worse, the behavior A11 blessed — "the redirect target is derived from the manifest,
`cards[0]`" — is wrong once a second profile exists. Profiles are discovered with
`readdirSync`, so `cards[0]` is whichever id sorts first, and the legacy `/scrumban/`
URL silently began pointing at the engine's own dogfood board rather than a product
board. "Derived, not hardcoded" is necessary but not sufficient: derived-from-alphabetical-
order is still arbitrary.

**A11 is therefore replaced, not relaxed:**

> **A11′** — `/scrumban/` (the legacy single-board URL) redirects to `/`, the root index,
> for ANY manifest: zero entries, one entry, or many, in any order. The engine's board
> output names no product. Proof: `scripts/board-autopublish.test.mjs` — the ordering test
> uses a two-entry manifest and asserts neither entry claims the redirect.

This amendment is recorded rather than applied silently: a contract edited to match the
code it is meant to judge is worthless. The validator should assess the amendment's
legitimacy as part of its verdict, and mark the mission FAIL if it concludes A11 was
weakened to accommodate a defect rather than corrected to expose one.

## House-standard gate (always applies)

- `pnpm test` from the factory repo root exits 0
  (`FACTORY_AUTOPUBLISH=0 FACTORY_PR=0 node --test "scripts/*.test.mjs"`).
- No new dependency outside `node:*`.
- Every new script keeps the `isMain` pattern, a header comment with Usage + exit
  codes, and soft-fail semantics.

## Robustness

- Corrupt / truncated / empty `project.json` and `critical-files.json` → defaults,
  no throw, no crash of a caller (`verdict.mjs`, `ratify.mjs`, `board-report.mjs`).
- A profile directory with only `project.json` (no seat.env, no validation.md) is
  legal — the optional paths come back `null`.
- A worktree path with a trailing slash still renders single-separator `//` rules.

## Verdict

Passes only when **every** assertion is green and `pnpm test` exits 0, proven
locally. Any red → FAIL with the failing assertion ids → back to the coordinator.
