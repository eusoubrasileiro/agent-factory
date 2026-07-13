# Validation Contract — seat-driver-leftovers

> Author: orchestrator (coordinator, Opus). Reader: the held-out validator.
> Written BEFORE code. Both features are `claude-worker.mjs`-only; serialize them.
> From `sonnet-fallback-seat/plan.md` features 02 + 03.

## Definition of done

Two ways the seat driver can silently do the wrong thing are closed: running GLM while you
believe you ran Sonnet (the alias trap), and burning a run into a z.ai rate-limit wall with no
actionable signal. Neither auto-fails-over — spend is Andre's decision (D-20); the driver
surfaces the fact and exits with a distinct code.

## Assertions

| id | Assertion (observable behavior) | Proof mechanism |
|----|----------------------------------|-----------------|
| A1 (F02) | `--model sonnet\|opus\|haiku` (an Anthropic alias) against a NON-Anthropic base URL is refused before spawn (z.ai resolves the alias through `ANTHROPIC_DEFAULT_*_MODEL` → you'd run GLM believing you ran Sonnet) — exit 2 with a message naming the trap | `claude-worker.test.mjs` — alias + z.ai base URL → refusal; a full model id (`claude-sonnet-5`) or `--allow-anthropic` with an Anthropic endpoint is allowed |
| A2 (F03) | on a z.ai rate-limit response (HTTP 429 / body `code 1308`), the driver exits **3** and prints the reset timestamp + a ready-to-paste fallback command — no auto-failover | `claude-worker.test.mjs` — a stubbed 429/1308 result → exit 3, reset time + fallback in output |
| A3 | normal runs unaffected: a full model id or a legitimate Anthropic seat still spawns; a non-429 error keeps its existing exit code | existing claude-worker tests stay green |
| A4 | no assertion deleted/weakened; full suite green | `pnpm test` vs baseline |

## Mutation gate
- F02: remove the alias-vs-non-Anthropic-endpoint guard → A1 red.
- F03: treat 429/1308 as a generic error (drop the exit-3 branch) → A2 red.

## Seats
- **[builder or coordinator]** `scripts/claude-worker.mjs` + `scripts/claude-worker.test.mjs`.

## Explicitly NOT in scope
- Feature 04 (wahub-side dispatch-worktree.sh repointing) stays BLOCKED until the wahub merge
  state clears (§0.1) — noted, not dropped.
- No auto-failover on rate limit (D-20): the driver reports and exits; sizing/switching is Andre's.

## House-standard gate
`pnpm test` exits 0; `node:test`/`node:assert/strict`; no dep outside `node:*`; headers/isMain kept.

## Verdict
Passes when A1–A4 green and `pnpm test` exits 0, each mutation turns its named test red. A driver
that resolves an alias to a different vendor's model while reporting success is the exact D-25
class this closes.
