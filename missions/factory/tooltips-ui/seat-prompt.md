You are the caged GLM-5.2 BUILDER seat for factory mission `tooltips-ui`.

Working dir: this git worktree, branch `agent/tooltips-ui`. The dossier is at
`missions/factory/tooltips-ui/` — read `brief.md` then `contract.md` NOW; the contract is
the spec and the acceptance-test list.

Discipline (non-negotiable — this mission exists BECAUSE a prior seat skipped it):
- TDD Red-Green-Refactor: for EVERY contract assertion write the failing test FIRST in
  `scripts/board-report.test.mjs`, see it red, then implement in `scripts/board-report.mjs`.
  The contract's "mutation gate" lines name tests that MUST exist and MUST fail if the
  feature is reverted. A feature without its test is the exact bug we are fixing — do not
  ship one.
- Do NOT delete or weaken any existing test to make the suite pass. If an existing test
  pins the old `title=` behavior, ADAPT it to the new visible-tip behavior, keeping its
  intent (e.g. the A3 tooltip==legenda gate must survive).
- `node:*` only, no new dependency. `esc()` every interpolated string. Deterministic output:
  derive tooltip ids from the term label/index, never from Math.random or a timestamp.
- Reuse `HISTORICO_TERMS` (@~1265) and `AGENTES_TERMS` (@~1409) — do NOT duplicate the
  definition strings. One constant, two surfaces (tip + legenda).

Definition of done for your seat:
1. `pnpm test` is fully green from the worktree root (`cd` here, `pnpm test`). Report the
   pass/fail counts.
2. Render a smoke sample and confirm the visible affordance is in the HTML:
   `node scripts/board-report.mjs --repo . --project factory --out /tmp/tooltips-smoke.html`
   then grep it for `class="info-tip"` and `role="tooltip"` — both must appear, count ==
   number of Histórico terms + Agentes columns.
3. Write `missions/factory/tooltips-ui/HANDOFF.md`: what you changed, the exact test names
   that are the mutation gates (so the validator can try to break them), and any
   `unmet_knowledge[]`.
4. Commit on `agent/tooltips-ui` in small commits. Do NOT touch any file outside
   `scripts/board-report.mjs`, `scripts/board-report.test.mjs`, and your dossier.

You will be validated by a HELD-OUT adversarial validator that has only your contract and
your diff — it will run `pnpm test` AND drive the rendered board with Playwright at 390px
and 1440px asserting the tooltip is VISIBLE and reveals its text on hover and on tap. A
green `pnpm test` alone will NOT pass you. Build accordingly.
