# Contract — rondas-honesty (F8)

**Project:** factory · **Seat:** worker (GLM-5.2, caged) · **Blast radius:** low (one renderer
function + tests, behind the publish guard). **Sequencing:** branch from the HEAD that already
contains F7 (hist-completion-metrics) — F8 touches the SAME file (`board-report.mjs`), a
different function; do not run concurrently with F7.

## Why (business)

The Agentes A/B tab shows **Rondas médias 0.3** for glm-5.2 and claude-sonnet-4-6. A round is
one full validation attempt, so an average *below 1* is nonsensical on its face — you cannot
validate something in less than one round. André flagged it. Ground truth (verified against the
missions' `stats.json`):

- glm-5.2: 12 missions, `rounds` = `[0,0,0,1,0,1,0,0,0,1,0,0]` → **9 are 0**, 3 are 1 → 3÷12 = 0.25.
- claude-sonnet-4-6: 4 missions, `rounds` = `[1,0,0,0]` → **3 are 0** → 1÷4 = 0.25.
- claude-sonnet-5: 2 missions, `[1,1]` → 1.0 (clean; both actually ran a round).

`rounds: 0` does **not** mean "validated in zero rounds" — it means **no validation round was
ever recorded**: the mission was completed/merged without going through the held-out
`mission-validate` seat that increments the counter (legacy missions, pre-instrumentation, or
direct merges). The current code (`aggregateAgents`, `board-report.mjs:~1424`) sums rounds over
**every** mission including the zeros, so real validation effort gets diluted by never-validated
missions and the average collapses below 1 — misleading, the same "not-measured conflated with
measured-as-zero" disease as lead-time "—" and the 26 legacy stats.

**The fix:** compute rondas-média only over missions that actually ran **≥1** recorded round,
and disclose how many were excluded. Then glm-5.2 reads **1.0** (3 ÷ 3) with "9 fora da média" —
true AND legible.

## Scope

`scripts/board-report.mjs` (function `aggregateAgents` + the Agentes render) and
`scripts/board-report.test.mjs` ONLY. Do not touch history.mjs, client-view, or F7's
`histCardValues`/`renderHistoryTab`.

## Requirements (EARS)

**R1 — rondas-média excludes never-validated missions.**
WHEN `aggregateAgents(missions)` computes `rondasMedia` for a model, it SHALL average `rounds`
only over that model's missions whose recorded `rounds` is a number **≥ 1**. Missions with
`rounds === 0` or `rounds` null/absent SHALL be excluded from BOTH the numerator and the
denominator. WHEN a model has zero missions with `rounds ≥ 1`, `rondasMedia` SHALL be `null`
(renders "sem dados"), never `0` and never `NaN`.
Result on real data: glm-5.2 → `1.0` (3÷3), sonnet-4-6 → `1.0` (1÷1), sonnet-5 → `1.0` (2÷2).

**R2 — the exclusion is disclosed per model.**
`aggregateAgents` SHALL also return, per model row, `semRonda` (or equivalently named) = the
count of that model's missions with `rounds` 0/null/absent (the ones excluded from R1). This is
data the render uses; existing returned fields are unchanged.

**R3 — the Agentes tab explains the exclusion.**
WHEN the Agentes tab renders and at least one mission across the table was excluded (Σ `semRonda`
> 0), a note SHALL render in that tab (a `<p class="muted">…`) stating the total count and why,
e.g.: `"N missões sem ronda de validação registrada (anteriores ao loop de validação ou mescladas
direto) ficam fora da média de rondas."` WHEN zero were excluded, the note SHALL NOT render.
The **Rondas médias** column definition in `AGENTES_TERMS` SHALL be updated to say the average is
over missions com ≥1 ronda registrada (keep it one line; it feeds both the `<th>` tip and the
legenda).

**R4 — `PASS de 1ª` is unaffected.** Do NOT change the pass-de-1ª computation
(`passed && rounds === 1`). Its denominator stays `ms.length` (all missions for the model) —
that metric is a different question ("of everything this model did, what fraction passed clean on
round 1") and is not part of this fix. Only `rondasMedia` and the new disclosure change.

**R5 — rules.** No product literals in `scripts/**` (`scripts/project-profile.test.mjs:370`
stays green). No `Date.now()`/`Math.random()`. Keep `isMain` guard + soft-fail. Tests are
`node:test` + `node:assert/strict` in the `pnpm test` globs.

## Verification

**V1** `pnpm test` green from repo root (0 fail; worktree board-sync skips are expected).

**V2 — board-report.test.mjs (RED first):**
- A model with rounds `[0,0,1,1]` → `rondasMedia === 1` (2÷2), `semRonda === 2`.
- A model with rounds `[0,0,0]` (or all null) → `rondasMedia === null`, `semRonda === 3`.
- A model with rounds `[2,0,1]` → `rondasMedia === 1.5` (3÷2), `semRonda === 1`.
- The Agentes note renders with the correct total when Σ semRonda > 0, and is absent when 0.
- `PASS de 1ª` for a seeded model is unchanged by the fix (pin it so R4 can't regress).

**V3 — rendered-DOM probe (held-out GLM-5.2 Playwright), per `projects/factory/validation.md`,
against the coordinator-served board at `http://127.0.0.1:8799/factory/`, at 390×844 and
1440×900:** the Agentes tab shows **Rondas médias 1** (not 0.3) for glm-5.2 and sonnet-4-6; the
"fora da média" note is visibly present beneath/near the table; the Rondas médias column ⓘ
reveals the updated definition on hover and tap. A bare `title=` or an invisible note → FAIL.

## Out of scope
Histórico tab, `PASS de 1ª` semantics, VPS republish (coordinator, after André's OK), M6.
