# Contract — hist-rondas-honesty (F10)

**Project:** factory · **Seat:** WORKER (caged GLM-5.2 build) · **Blast radius:** low —
operator-only telemetry card + one aggregate; behind the publish guard, reversible.

## Why (business)

F8 (`rondas-honesty`, ratified 2026-07-14) established the honest rule for "rondas média":
average **only over missions that recorded ≥1 validation round**, with a note disclosing the
excluded ones — so the number isn't dragged toward zero by legacy / merged-straight-to-Done
missions that never ran a round. **F8 applied that rule to the Agentes per-model column
(`board-report.mjs` `getAgentesRows`, `rounds >= 1` filter + `semRonda` note) but NOT to the
Histórico global "rondas média" stat-card.** The Histórico card still:
1. computes `rondasMédia` over **every** mission (`history.mjs` `aggregateScope`, lines ~353–363:
   `typeof latest.rounds === "number"` counts rounds-0 missions too), and
2. is **mislabeled** "média de rondas de validação **por missão concluída** (history.jsonl)"
   (`board-report.mjs:1480`) — a denominator that matches neither the computation (all missions)
   nor F8's rule (≥1-round).

The lie is invisible where completions exist, but on **wahub** (`taxa de conclusão` = 0%, zero
concluded) the card renders **"0.1 rondas média por missão concluída"** — impossible: an average
"por missão concluída" over **0** concluded missions cannot be 0.1. A caged GLM-5.2 visual
validator caught it on 2026-07-15 (the F9 eyes-on retrofit). This mission finishes F8: it makes
the Histórico global stat obey the same honest denominator and label as the Agentes column, so the
two panels agree and no viewer sees a contradictory number.

## Scope

`scripts/history.mjs` (+ `scripts/history.test.mjs`), `scripts/board-report.mjs`
(+ `scripts/board-report.test.mjs`). Do NOT touch the Agentes-column code (already correct),
`claude-worker.mjs`, `cage-settings.mjs`, or any product.

## Requirements (EARS)

**R1 — the Histórico global `rondasMédia` counts ONLY missions with ≥1 recorded round.**
In `aggregateScope` (`history.mjs`), the `rondasMédia` accumulator SHALL include a slug's latest
snapshot in the mean **only when** its `rounds` is a number **and `>= 1`**. Missions whose latest
`rounds` is `0`, `null`, or absent SHALL be **excluded** from both numerator and denominator
(mirrors F8's Agentes rule, `board-report.mjs` `getAgentesRows`). WHEN no mission has `rounds >= 1`,
`rondasMédia` SHALL be **`null`** (rendered "sem dados"), NEVER `0` (a `0` here is the misleading
value F8 exists to prevent). Existing behaviour where all counted missions have `rounds >= 1`
(e.g. rounds 1 & 2 → mean 1.5) SHALL be unchanged.

**R2 — expose the excluded count for a Histórico honesty note.**
`aggregateScope` SHALL add a field `missõesSemRonda` (integer ≥ 0) = the number of scope slugs
whose latest `rounds` is `0`/`null`/absent (the ones excluded from R1). It SHALL be present on
every scope object the function returns (global and each `byProject`), same as the other stat
fields, so `concluídas`/`não-concluídas`/`semRonda` all reconcile against `totalMissões`.

**R3 — relabel the Histórico stat-card definition to match the computation.**
The `rondas média` term definition (`board-report.mjs:1480`, in the Histórico terms table) SHALL
change from "…por missão concluída (history.jsonl)" to a wording that names the **≥1-round**
denominator, e.g. **"média de rondas de validação sobre as missões com ≥1 ronda registrada
(history.jsonl)"** — consistent with the Agentes column definition (`board-report.mjs:1707`).
No other term definition changes.

**R4 — a Histórico "fora da média de rondas" note discloses the excluded missions.**
WHEN `missõesSemRonda > 0`, the Histórico panel SHALL render, near the `rondas média` stat, a
muted note stating N missions without a recorded validation round are outside the average — same
honesty note F8 put on the Agentes tab (`board-report.mjs:1753`, `rondas-nota` class), phrased for
the global scope (e.g. "N missões sem ronda de validação registrada … ficam fora da média de
rondas."). WHEN `missõesSemRonda === 0`, the note SHALL be absent (no empty note).

**R5 — rules.** No product literals anywhere in `scripts/**`
(`scripts/project-profile.test.mjs:370` stays green — the wahub reference in this prose does NOT
enter `scripts/**`). No `Date.now()`/`Math.random()` in the rendering/aggregate paths (the tests
inject `now`). `fmtStat(null)` already yields "sem dados" — reuse it; do not invent a new formatter.
Keep every script's `isMain` guard, header comment, and soft-fail semantics. `resolveProject`
stays TOTAL.

## Verification (gate necessary, NOT sufficient)

**V1 — `pnpm test` green** from the factory repo root (worktree board-sync skips expected).

**V2 — unit (RED first, TDD):**
- `history.test.mjs`: a scope with mixed rounds (e.g. slugs with rounds 2, 3, 0, null) → `rondasMédia`
  = mean over ONLY the ≥1-round ones (`(2+3)/2 = 2.5`), and `missõesSemRonda = 2`. A scope where
  **no** mission has `rounds >= 1` → `rondasMédia === null` and `missõesSemRonda ===` (count). The
  two existing assertions that currently expect `rondasMédia === 0` (the "no Done" case ~line 407
  and the "empty rows" case ~line 415) SHALL be updated to expect **`null`** (empty rows →
  `missõesSemRonda === 0`; the no-round case → its excluded count). The rounds-1-&-2 → 1.5 case
  (~line 377) stays green unchanged.
- `board-report.test.mjs`: the Histórico panel renders the relabelled `rondas média` definition
  (asserts the new ≥1-round wording, and that "por missão concluída" no longer labels this term);
  a model with `rondasMédia: null` renders "sem dados" for that card (not "0"); with
  `missõesSemRonda > 0` the `rondas-nota`-style Histórico note is present; with `missõesSemRonda: 0`
  it is absent.

**V3 — held-out GLM-5.2 visual re-check (coordinator-orchestrated).** Re-render factory + wahub,
serve on `127.0.0.1:8799`, spawn a `--with-playwright` GLM validator: on the Histórico panel the
`rondas média` card reads a value consistent with its new ≥1-round label (or "sem dados"), the ⓘ
definition names the ≥1-round denominator, and — on wahub — there is no longer a "por missão
concluída" number contradicting `taxa de conclusão = 0%`. This is the same probe that caught the
bug, now expected to pass.

## Out of scope
The Agentes column (already F8-correct); F2's contradiction-lint; the VPS republish (coordinator,
after André's OK); any product file.
