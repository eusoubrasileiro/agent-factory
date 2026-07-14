# Brief — tooltips-ui (F1)

## Why
André opened the board, hovered the Histórico KPI tiles, and saw **nothing**. The M4
"tooltips" shipped as native `title=` attributes — invisible-on-hover on desktop (long
delay, tiny native chrome) and **completely dead on touch/mobile**. A definition a viewer
cannot discover is not a definition. This mission replaces `title=` with a real, visible,
discoverable tooltip that works with a mouse AND a finger.

## Who it serves
André (operator/researcher) reading the science layer — Histórico KPI tiles and the
Agentes A/B column headers. He must be able to learn what every number means without
guessing. Business value: a meter you can't read doesn't get read; this is what makes the
science instrument actually usable.

## Scope
`scripts/board-report.mjs` + `scripts/board-report.test.mjs` ONLY. Presentation layer:
the definitions already exist in `HISTORICO_TERMS` (@1265) and `AGENTES_TERMS` (@1409) and
already feed `renderLegenda`. Reuse those SAME constants — one source, better surface.

## Out of scope
The staleness banner and contradiction lint (F2), Agentes data (F3), kpi (F4), the client
page (`client-view.mjs` stays script-free — it has no tiles). Do not touch data derivation.
