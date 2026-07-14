# client-view — M5 of Board v5 (plan: ~/.claude/plans/lovely-nibbling-teapot.md, W3)

**Business why:** the paying client (a non-technical stakeholder) cannot read the
operator board and today cannot even log in. A plain-PT funnel page — o que pedi → em
que pé está → o que entrou no ar — lets him self-serve status instead of pinging André
on WhatsApp. This is the only mission in the wave that creates direct customer value.

**Who it serves:** the client viewer persona. Research-gated design (2026-07-14):
stakeholder view hides internal critique + model names + cost; shows outcome-level
progress only.

**Security framing (D-30 narrowed, D-52-era):** the rendered client HTML is a
PUBLISHED artifact on a client-visible URL. It must be built from a WHITELIST — start
from nothing and add only allowed fields. It must never contain: money/$, token counts,
model names, mission slugs, `# Detalhamento técnico` blocks, `business-decision`
(engagement) rows, lane jargon, or engineering vocabulary. The leak test IS the
contract's heart.
