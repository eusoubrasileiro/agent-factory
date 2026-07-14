You are the caged GLM-5.2 BUILDER seat for factory mission `board-banner-lint`.

Working dir: this git worktree, branch `agent/board-banner-lint` (it already contains F1's ⓘ
tooltips — do NOT touch `renderInfoTip`, the term constants, or tooltip CSS/JS). The dossier is
at `missions/factory/board-banner-lint/` — read `brief.md` then `contract.md` NOW.

Discipline (non-negotiable — these two features were CLAIMED done before and never written; that
is the exact failure you are fixing):
- TDD Red-Green-Refactor: for EVERY contract assertion write the failing test FIRST in
  `scripts/board-report.test.mjs`, see it red, then implement. A feature without a failing-first
  test is forbidden here.
- The contradiction-lint test MUST assert RENDERED chips (count `chip-contradicao` in the card
  HTML), NOT a `<style>`/CSS class-name match — a regex hitting a stylesheet string is a
  false-red that already bit this repo 3×.
- Determinism: the staleness age is computed CLIENT-SIDE at view time; the server emits only the
  ISO `data-generated-at`. Do NOT embed `Date.now()` in the rendered HTML — a determinism test
  in the suite compares two renders of identical state byte-for-byte; keep it green.
- `node:*` only. `esc()` every interpolated reason/age. Do not weaken existing tests.

Definition of done:
1. `pnpm test` fully green from the worktree root. Report pass/fail counts.
2. Smoke: `node scripts/board-report.mjs --repo . --project factory --out /tmp/f2.html`, then
   grep /tmp/f2.html for the banner container (`data-generated-at`) and confirm the client
   `<script>` contains the 30-min threshold logic. If any mission is genuinely contradictory it
   shows `chip-contradicao`; otherwise construct a fixture test that proves the chip renders.
3. Write `missions/factory/board-banner-lint/HANDOFF.md`: what changed, the mutation-gate test
   names, any `unmet_knowledge[]`.
4. Small commits on `agent/board-banner-lint`. Touch ONLY `scripts/board-report.mjs`,
   `scripts/board-report.test.mjs`, and your dossier.

A held-out validator will run `pnpm test` AND drive the rendered board with Playwright: it will
inject an old `data-generated-at` and assert the staleness banner becomes VISIBLE, and seed a
Done+no-verdict mission and assert the ⚠ chip shows. Green tests alone will not pass you.
