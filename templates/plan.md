# Plan — <slug>

> **Author: orchestrator. Reader: Andre (approves) + workers + validators.**
> The SCOPE tree: milestones → features. Pairs with `contract.md` (the correctness
> net). Andre's approval of plan + contract is the **one gate** before execution.

## Summary
<2–3 sentences: what this mission delivers, derived from the brief.>

## Milestones
<Ordered. Each milestone ends in a validator pass against the contract.>

1. **M1 — <name>** — <one line>
2. **M2 — <name>** — <one line>

## Features
<Each becomes a self-contained `features/NN.md`. Mark dependencies — workers
serialize only on a real dependency; independent features may run in parallel.>

| NN | Feature | Milestone | Depends on | Touches (high level) |
|----|---------|-----------|------------|----------------------|
| 01 | <name> | M1 | — | <files/area> |
| 02 | <name> | M1 | 01 | <files/area> |

## Coverage check (orchestrator must pass before workers start)
Every assertion in `contract.md` is carried by ≥ 1 feature below.

| Contract assertion | Covered by feature(s) |
|--------------------|-----------------------|
| A1 | 01 |
| A2 | 02 |

> If any assertion has no feature, the plan is incomplete — fix before building.

## Open questions for Andre (asked one at a time before approval)
- <strategic question 1>
- <strategic question 2>
