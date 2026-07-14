# stats-backfill — M2 of Board v5 (plan: ~/.claude/plans/lovely-nibbling-teapot.md, W1)

**Business why:** 26 of 44 mission dossiers have no `stats.json`, so the Agentes tab
shows one starving row and ~80% of Histórico $/tempo cells say "sem dados" — the board
can't answer André's "is the factory worth it" question (RUNBOOK §Measure it). A
repeatable backfill driver turns the existing collector loose on every dossier.

**Who it serves:** André (science/tracking layer). Prereq for M7 (agentes-evidence).

**Scope:** ONE new file `scripts/stats-backfill.mjs` + its test
`scripts/stats-backfill.test.mjs`. Nothing else. The actual production RUN over real
dossiers is the coordinator's job after merge (product repos aren't reachable from
this worktree) — you build and prove the tool.
