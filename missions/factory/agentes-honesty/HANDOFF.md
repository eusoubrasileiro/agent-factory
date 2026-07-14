# HANDOFF — agentes-honesty (F3)

Coordinator-built (1-line honesty note + test; a full seat cycle was disproportionate).

## Recovery (data, on main — folded into the F6 wave commit)
Re-ran `mission-stats.mjs collect` on the two missions whose stats.json had a null
worker model but whose metrics.jsonl carried a worker-seat model (stale cache, not a
seatModel bug — seatModel already reads phase_start|phase_end). Recovered:
- agentes-evidence → models.worker = glm-5.2
- vocabulary-trust → models.worker = glm-5.2
20 → 22 of 51. The other 3 "recoverable" are NOT worker attributions (validate-demo-ui /
validate-google-oauth carry a *validator* model; factory-extract an *orchestrator* model)
— attributing them as worker would be a lie; they stay in the honest-note bucket.
(metrics.jsonl are untracked runtime files that live only in the main checkout, so the
regen must run there, not in a worktree.)

## The note (code, this branch)
renderAgentsTab: when `semStats > 0`, render a `cobertura-nota` line explaining the gap —
"As N sem modelo (legadas … ou executadas por validador/orquestrador) entram no total mas
ficam fora da comparação A/B." Rendered in both the empty and populated branches; absent
when coverage is complete.

## Mutation gates
- `agentes-evidence: coverage line shows N of M …` — now also asserts `cobertura-nota` + the
  A/B-exclusion text.
- `agentes-evidence (F3): no cobertura-nota when every mission has a model` — the gap-free case.
