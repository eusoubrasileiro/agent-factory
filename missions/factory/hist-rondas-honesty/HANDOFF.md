# Handoff — hist-rondas-honesty (F10)

**Outcome:** DONE, gate-green, GLM-confirmed. Completes F8's honesty rule on the Histórico
global "rondas média" stat (F8 had fixed only the Agentes column).

**Discovered by:** the F9 eyes-on retrofit (2026-07-15) — a caged GLM-5.2 visual validator
driving the wahub board flagged "rondas média = 0.1 por missão concluída" against
"taxa de conclusão = 0%" (an impossible per-concluded average over zero concluded missions).
Green `pnpm test` and coordinator review had both missed it.

**Root cause:** `history.mjs aggregateScope` averaged `rounds` over **all** missions (rounds-0
included → `0.1 = 2/27` on wahub) while `board-report.mjs:1480` mislabeled it "por missão
concluída". F8's ratified rule (≥1-round denominator + disclosure note) was applied to the
Agentes per-model column but never to this global card.

**Fix (4 files):**
- `history.mjs` — `rondasMédia` counts only missions with `rounds >= 1`; `null` (not `0`) when
  none; new `missõesSemRonda` field on every returned scope.
- `board-report.mjs` — relabel the term to "…sobre as missões com ≥1 ronda registrada
  (history.jsonl)"; render a Histórico `rondas-nota` disclosure when `missõesSemRonda > 0`.
- `history.test.mjs` / `board-report.test.mjs` — new coverage + two `0 → null` updates.

**Verification:**
- Held-out gate (coordinator-run): 828 tests, 821 pass, 0 fail, 7 skip. NB: the builder seat
  self-reported "867" — a miscount; the real baseline was 822, +6 F10 = 828. Do not trust seat
  self-tallies; the coordinator re-runs.
- Arithmetic reconciled: wahub rounds dist `{0:25, 1:2}` → old `2/27 ≈ 0.074 → "0.1"`; honest
  `2/2 = 1.0`, 25 disclosed. factory: value 1, 24 disclosed.
- V3 GLM-5.2 visual validator (the same probe that caught the bug): **PASS** — A1 ≥1-round
  label, A2 no 0%-completion contradiction, A3 disclosure note all green.

**Not done here:** the two disclosure notes carry different counts by design — Agentes "4"
(validate.log per-model) vs Histórico "25" (history.jsonl global): different data sources, each
honest about its own panel. VPS republish is coordinator-gated on André (batched with F7/F8/F9).

**Follow-up (not F10):** the Agentes-vs-Histórico "sem ronda" count divergence is defensible but
could confuse; if it ever reads as a contradiction, unify the vocabulary or cross-reference the
two notes. Tracked only here, not scheduled.
