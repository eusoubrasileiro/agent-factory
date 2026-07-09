# Validation Contract — sonnet-fallback-seat

> **HONESTY NOTE, read this first.** This contract was written **after** feature 01's code,
> not before it. That inverts the factory's own rule (C3: the worker never authors its own
> contract, and the contract precedes the code). It is recorded rather than hidden. Feature 01
> was written on the coordinator seat during a conversation, not dispatched as a mission.
> Features 02–04 below are **not yet built**, and their assertions ARE contract-first.
> A held-out validator should weight A1–A5 accordingly: they document what exists, they did
> not constrain it.

## Definition of done

The default builder is unchanged. Sonnet is reachable by typing one flag, stays caged, and
cannot be reached by accident. A rate-limited builder reports the limit instead of hanging.
A model alias that would silently resolve to a different model is refused.

## Assertions

| id | Assertion | Proof | Status |
|----|-----------|-------|--------|
| A1 | Default path unchanged: no flag → an absent/`anthropic.com` base URL still exits 2 | `claude-worker.test.mjs` | **built** |
| A2 | `--allow-anthropic` permits an `anthropic.com` endpoint AND no credentials at all | `claude-worker.test.mjs` | **built** |
| A3 | An opt-in seat is still CAGED — `<worktree>/.claude/settings.external.json` is written | stubbed-`claude` CLI test | **built** |
| A4 | The guard never echoes the token, on any path | `claude-worker.test.mjs` | **built** |
| A5 | A coordinator `ANTHROPIC_*` var cannot override the seat credential | `claude-worker.test.mjs` | **built** |
| A6 | `--model sonnet` (or `opus`/`haiku`) with a NON-Anthropic base URL is refused, naming `ANTHROPIC_DEFAULT_SONNET_MODEL` | new test | **not built** |
| A7 | A `429`/`rate_limit_error` response exits with code **3**, prints the provider's reset timestamp verbatim, and prints the exact Sonnet fallback command | new test, stubbed 429 body | **not built** |
| A8 | No automatic failover: nothing in the driver switches model on a 429 | grep + test | **not built** |
| A9 | wahub exposes `factory:claude`, `factory:sonnet`, `probe:cage`, `probe:secrets`, `mission:verdict` | `pnpm <script>` resolves | **not built** |
| A10 | Spawning a seat **without `--project`** does not silently drop the Critical-File denies | new test | **not built** |

## Why A10 exists (found while verifying this contract, 2026-07-10)

`claude-worker.mjs` calls `writeCageSettings(dirAbs, { project: opts.project })`. With no
`--project`, `resolveProject` degrades to the generic base cage: **11 deny rules, and none of
the product's Critical Files.** Measured: `--project wahub` → 35 rules; no flag → 11.

So forgetting one flag silently removes exactly the protection the cage exists for, and nothing
says a word. This is the same failure class as the telemetry misroute (a wrong/absent `--project`
writing the KPI numbers into another project's tree), and it is worse, because it is a security
control rather than an instrument.

The fix is not "remember the flag". Candidates: warn loudly on stderr when a seat is caged with
zero Critical Files; or refuse to spawn without `--project` unless `--allow-uncaged` is also typed.
Andre decides which, because the second one can block a legitimate engine-only run.

## Why A6 exists (it silently poisons an A/B)

Claude Code resolves the `sonnet` alias through `ANTHROPIC_DEFAULT_SONNET_MODEL`, which z.ai's
own setup guide (`docs/glm-cage-briefing.md` §3a) tells you to set to `glm-5.2`. Passing
`--model sonnet` at a z.ai base URL runs **GLM twice**. Two near-identical scorecards, and the
conclusion that the models are equivalent. That is a configuration error, not a choice.

## House gate

`pnpm test` exits 0. No dependency outside `node:*`. Zero product literals in `scripts/`,
`templates/`, `skills/`. Every new script keeps `isMainModule`, a header with Usage + exit
codes, and soft-fail side channels.

## Verdict

Passes only when every **built** assertion is green and `pnpm test` exits 0. The unbuilt ones
are the mission's remaining scope, not a pass.
