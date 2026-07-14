# Brief — board-banner-lint (F2)

## Why
Two M4 features were listed as done in a commit message and in the coordinator's summary, but
a repo-wide grep proved **neither exists in code**: (1) a **staleness banner** that warns when
a board tab was opened long after it was generated, and (2) a **contradiction ⚠ lint** that
flags missions in impossible states (Done but never validated, "aprovar plano" but work
already delivered, "aprovar merge" but last verdict FAIL). Their tests were dropped too, which
is why the green gate never caught the gap. This mission builds both — with the tests this time.

## Who it serves
André (operator). The banner stops him trusting a stale tab; the lint stops him trusting a
card whose state is self-contradictory. Both are trust features for the science board.

## Scope
`scripts/board-report.mjs` + `scripts/board-report.test.mjs` only. This branch already has F1's
ⓘ tooltips — leave them alone. Pure decision helpers + one client-side reveal for the banner +
a build-time ⚠ chip for the lint.
