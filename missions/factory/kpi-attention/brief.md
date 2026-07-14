# kpi-attention — M8 of Board v5 (plan: ~/.claude/plans/lovely-nibbling-teapot.md, W4)

**Business why:** the expensive layer (Opus coordinator + André's attention) is the
unmeasured one. Without it, RUNBOOK §Measure it's graduation rule ("kill the factory if
attention-per-feature doesn't fall") is unmeasurable. Spec provenance: Plan A F4+F5
(docs/plan-A-ship-truth-2026-07-11.md:120-151), already scoped by the Fable planner.

**Who it serves:** André (the kill-or-scale decision on the factory).

**Scope:** new `scripts/session-cost.mjs` + tests; new `scripts/kpi.mjs` + tests +
`"kpi"` entry in package.json scripts. Reuse `scripts/lib/transcript-tokens.mjs`
(`encodeTranscriptDir`, `loadTranscriptUsage`) — do not reimplement transcript parsing.
Skill emitter fixes are the coordinator's (skills/ are outside your allowed files).
