# Plan — sonnet-fallback-seat

## Features

| # | Feature | Seat | Status |
|---|---------|------|--------|
| 01 | `--allow-anthropic`: Sonnet as a typed, caged opt-in | coordinator (secrets-handling driver) | **done** `4a85c2f` |
| 02 | Alias-trap guard: refuse `--model sonnet\|opus\|haiku` at a non-Anthropic base URL | coordinator | pending |
| 03 | Rate-limit detection: exit 3, print reset time + fallback command, never auto-failover | coordinator | pending |
| 04 | Wire the seats into wahub (`package.json`, `dispatch-worktree.sh`, `CLAUDE.md`) | coordinator (secrets-handling) | pending |
| 05 | A seat spawned without `--project` must not silently lose its Critical-File denies | coordinator (**Andre picks warn-vs-refuse**) | pending |

**Seat assignment.** Every feature touches `claude-worker.mjs` — the file that decides whether a
seat sees real secrets and whether it is caged — or wahub's dispatch script. An external builder
must never author either (C3). All four are coordinator-seat work. This is not a fallback because
GLM is rate-limited; it is the rule.

## Findings from verifying this contract

- **Feature 05 was found by running A3, not by reading code.** `--project wahub` renders 35 deny
  rules; omitting the flag renders 11 — the generic base, with zero Critical Files. The cage is
  still *a* cage (self-protect, `git push`), but the product globs are gone and nothing warns.
  Forgetting a flag must not silently disarm a security control.

## Notes carried from the session

- z.ai external seat: **max concurrency 10**; usage is a **5-hour rolling window**, not credit.
  Ten seats drain it 5× faster than two — fan-out is a spend decision (D-20).
- `total_cost_usd` is fiction on a flat plan (D-13). Compare seats by tokens/feature.
- `permission_denials` is **incomplete**, not empty (D-23). Never assert on it.
