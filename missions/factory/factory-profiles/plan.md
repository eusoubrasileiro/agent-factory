# Plan — factory-profiles (W-A of Factory v2.2)

Full program plan: `docs/plan-v2.2-generic-engine.md`. Ratified by Andre 2026-07-09.

## Milestones → features

| # | Feature | Seat | Depends on | Status |
|---|---------|------|-----------|--------|
| 01 | wahub profile files (`project.json`, `critical-files.json`, `seat.env`, `validation.md`) | coordinator (data + prose judgment) | — | done `28223a5` |
| 06 | `factory` dogfood profile | coordinator | 01 | done `28223a5` |
| 02 | Resolver loads the profile (`resolveProject().profile`) | GLM-5.2 builder | 01 | done `e003e80` |
| 04 | Engine de-literalized: skills, board-index, probe-secrets, comments | coordinator (agent surfaces = markdown) | 02 | done `af44b70` |
| 07 | wahub `dispatch-worktree.sh` → profile `seat.env` | coordinator (**secrets-handling; Andre ratifies the diff**) | 01 | done (uncommitted, wahub repo) |
| 03 | Cage renders base template + profile critical files | GLM-5.2 builder | 02 | done `253035a` (+ coordinator fix `a208972`) |
| 05 | Profile conformance suite + engine-literal meta test | GLM-5.2 builder | 02, 03 | done `726ac58` (+ coordinator polish `83f476a`) |

Serial on real dependencies only. 03 must land before 05 (05 asserts on
`criticalFileRules` and on the slimmed base template).

## Seat assignment rationale

Features touching **Andre-facing prose** (skill instructions, validation playbooks)
or **secrets-handling files** stay on the coordinator seat — the first because
agent surfaces are reviewed markdown, the second because an external model must
never author the file that decides whether it sees real secrets. Pure
code+test features go to the GLM builder with a fully-pasted context seed.

## Contract coverage check

Every assertion in `contract.md` is carried by ≥ 1 feature:

| Assertion | Carried by |
|---|---|
| A1 profile files exist, template moved | 01 |
| A2 `profile` block exposed | 02 |
| A3 resolver TOTAL (unknown/missing/corrupt) | 02 |
| A4 no product-literal fallback | 02 |
| A5 cage emits Edit+Write per glob, audit-clean | 03 |
| A6 base template has zero product paths | 03 |
| A7 generic cage invariants + `.claude/**` pin survive | 03 |
| A8 conformance suite iterates every profile | 05 |
| A9 grep gate: zero literals | 04 (+ enforced in code by 05) |
| A10 dispatch renders dummy env from the new path | 07 (acceptance run) |
| A11 board-index output derived, not hardcoded | 04 |
| A12 test count grew; nothing deleted | 01 (seat-env moved), 03 (wahub assertion moved → 05) |

No assertion is uncovered.

## Acceptance (coordinator runs after 05)

```bash
cd tools/factory
pnpm test                                              # all green, count grew
grep -rn "wahub" scripts/ templates/ skills/ | grep -v '\.test\.mjs'   # ZERO
node scripts/cage-settings.mjs print /tmp/wt --project wahub           # 12 globs, Edit+Write
node scripts/cage-settings.mjs print /tmp/wt                           # base only, no product paths

cd ../../products/wahub
bash scripts/dispatch-worktree.sh probe-v22 --seat external            # dummy env from profile
node ../../tools/factory/scripts/probe-secrets.mjs .claude/worktrees/probe-v22   # exit 0
pnpm cleanup:worktrees
```

Then hand to `/mission-validate` with a **fresh** seat (contract + diff only).

## Observed telemetry (feeds the Agentes tab)

| Feature | Seat | Model | Tokens | Wall | Outcome |
|---|---|---|---|---|---|
| 02 | worker | glm-5.2 | 1,715,044 | 30 min (hit cap) | committed green, then **hung until SIGKILL** — the W-B kill-grace bug, reproduced |
| 03 | worker | glm-5.2 | 1,657,097 | 13 min | exit 0, green; left one product literal in template prose (coordinator fixed) |
| 05 | worker | glm-5.2 | 1,578,794 | 11 min | exit 0, green; 311-line suite, zero on-disk findings, honest handoff |

Three GLM features: ~4.95M tokens, ~54 min wall. One hang in three (the 02
worker finished its commits and then never exited). `opencode-worker.mjs` kills
with a straight `SIGKILL` at timeout; W-B replaces that with SIGTERM → 30 s
grace → SIGKILL. Nothing was lost here because the commits preceded the hang —
exactly the near-miss that motivates the fix.

Coordinator-seat cost is not in this table and dominates: every builder handoff
was independently re-verified (mutation-testing the conformance suite, rendering
both cage variants, probing the real `.env`), which is where the two regressions
below were actually caught.

## Outcome

**Verdict: PASS**, round 1, recorded `c243633` (`validate.log`). Suite 348 → 384.

The held-out validator returned PASS on all 12 assertions and found one defect the
contract never covered — `probe-secrets`'s dummy-value subtraction had been dead
since it was written (`scripts/templates/external-seat.env` never existed). That is
the seat earning its keep: the finding came from the one reader who had not seen
the code.

Two further regressions were found by the coordinator, neither covered by the contract:

1. **The legacy `/scrumban/` redirect followed alphabetical order.** `cards[0]` reads
   as "the product this board was built for" only while one profile exists; F6 added a
   second and the legacy URL silently moved to the engine's dogfood board. Fixed to
   `/` (the root index) and pinned with a two-entry ordering test. Contract A11 was
   **replaced by A11′ in a recorded amendment**, not quietly edited — and the validator
   was asked to judge whether that was a strengthening or a weakening. It said
   strengthening.

2. **`--project` is now mandatory.** With two profiles there is no sole entry, so the
   resolver synthesizes `default` and engine commands look in `missions/default/`.
   They fail loudly (nothing is written to the wrong place), but the message now names
   the searched directory and tells you to pass `--project`.

Both are consequences of the mission's own F6, invisible to a suite that was green
before F6 existed. The lesson worth carrying: **a contract written before the code
can encode a premise the plan itself is scheduled to destroy.** A11 said "when wahub
is the sole manifest entry" while F6, three rows above it in this very table, was
queued to add a second one.
