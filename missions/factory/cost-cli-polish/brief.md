# Brief — cost-cli-polish (dogfood on Sonnet 4.6)

## Context

The `factory-cost-metrics` work (Stages 1–3) shipped the cost/token/time pipeline:
`pricing.mjs` → per-seat recording → `mission-stats` → `spend.mjs` CLI + the Histórico
dashboard cards. It is green (540 tests). Two small, real follow-ups were flagged at
delivery and deliberately left for a clean follow-up mission. This is that mission.

It is also the **first factory mission driven on Anthropic Sonnet 4.6 seats** — the z.ai
flat plan is exhausted today, so both the builder and the held-out validator run on
`claude-sonnet-4-6` via `claude-worker.mjs --allow-anthropic`. That is intentional: it is
the only configuration in which the cost pipeline records *real, priced* API dollars for
the worker and validator seats, so this mission doubles as the end-to-end proof that the
factory can finally answer "does it save more than it spends?".

## The two follow-ups

1. **Negative dollars render with the sign in the wrong place.** `fmtUsd(-59.5)` returns
   `"$-59.50"` in both `scripts/spend.mjs` and `scripts/board-report.mjs`. Negative
   savings (API < Plan — the plan is *losing*) is exactly the number a reader most needs
   to read cleanly, and `$-59.50` is a formatting glitch. It must render `"-$59.50"`.

2. **The two rollups disagree on a zero plan fee.** `history.mjs` computes
   `planTotal = typeof planFeeUsd === "number" && … ? planFeeUsd : null`, so a plan fee of
   `0` yields `planTotal: 0`. `spend.mjs` treats `0` as falsy → `null` ("no plan basis").
   The two must agree: a `0` fee means "no plan cost basis", i.e. `null`, in both.

## Why it is low-risk (and why that is the point)

Both changes are pure formatting/aggregation on already-tested functions, with no schema,
API, or product-code surface. This is the right shape for the *first* Sonnet-seat run: a
clean single-pass mission that exercises the full plan→build→validate loop and the cost
telemetry, without inviting a fix-loop. Bigger follow-ups (board-autopublish FACTORY_ROOT
resolution from inside a worktree) are deliberately **out of scope** — recorded, not done.

## Seat

`claude-sonnet-4-6` builder + `claude-sonnet-4-6` held-out validator, both caged
(`--project factory`), Anthropic-billed (operator plan quota), telemetry on.
