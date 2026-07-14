# agentes-evidence — M7 of Board v5 (plan: ~/.claude/plans/lovely-nibbling-teapot.md, W4)

**Business why:** André runs model A/Bs (precedent: D-10, full-38 GLM vs Gemini) and the
Agentes tab is where that evidence should live at a glance — but it silently renders
whatever fraction of missions happen to have stats.json, presenting 40% coverage as if
it were the whole story. An evidence table that hides its own denominator isn't evidence.

**Who it serves:** André (science/research/tracking — the model-choice decisions).

**Depends on:** M3 and M4 merged (board-report.mjs will have moved under you — anchor
on function names, not line numbers). M2's backfill will have raised real coverage.
