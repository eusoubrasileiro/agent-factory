# Brief — kpi-coord-global (F4)

## Why
`pnpm kpi` is André's "is the factory worth it" instrument. Today it prints the same
factory-global coordinator-token number on every project row, so it reads as if each project
spent that much — misleading exactly the person the meter is for. The code already knows this
(the docstring flags it as a v1 limitation awaiting "F4"). This IS F4: render that number
honestly — once, labeled global — without faking a per-project split that doesn't exist.

## Who it serves
André (owner/researcher) making the kill-or-scale call on the factory. An honest meter or no
meter.

## Scope
`scripts/kpi.mjs` + `scripts/kpi.test.mjs` only. Presentation of one number. Do NOT touch the
per-project math (MERGED, SEAT-TOK, ATTN, ATTN/FEAT are correct). Do NOT attempt the real
per-project session-tag join (out of scope — needs coordinator session tagging that does not
exist yet).
