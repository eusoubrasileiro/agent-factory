# Contract — hist-completion-metrics (F7)

**Project:** factory · **Seat:** worker (GLM-5.2, caged) · **Blast radius:** low (renderers + aggregate + tests, behind the publish guard).

## Why (business)

The Histórico tab shows **missões concluídas** but no denominator, so André can't see
completion as a *ratio* — "8 done" is meaningless without "of how many". And the per-mission
**Lead time** column shows "—" for 48 of 56 missions, which reads as *broken* when it is in
fact *correct*: lead time is measured only from a mission's creation to its first `Done`, and
those 48 have never reached Done. Ground truth (verified against the live `history.jsonl`):

- 56 unique missions; **8 reached Done** (→ real lead time), **48 never did** (→ "—").
- Every single "—" lead time is a not-yet-concluded mission. **Zero are a data gap.**
- So: missões concluídas = 8, não concluídas = 48, taxa de conclusão = 8/56 ≈ 14%.
- The 48 "—" lead times ARE the 48 não-concluídas — the two must reconcile exactly.

This makes the board honest twice: a completion ratio André can read at a glance, and a "—"
that explains itself instead of looking like a bug.

## Scope

Two files only: `scripts/history.mjs` (aggregate) and `scripts/board-report.mjs` (render),
plus their `.test.mjs`. Do **not** touch client-view, CSS unrelated to this, or any product.

## Requirements (EARS)

**R1 — aggregate() exposes the completion denominator.**
WHEN `aggregate(rows, opts)` runs, its returned object (and every `byProject[p]` scope, and
`global`) SHALL include:
- `totalMissões`: number — count of unique slugs in that scope (`bySlug.size`).
- `missõesNãoConcluídas`: number — `totalMissões − missõesConcluídas` (never negative).
- `taxaConclusão`: number|null — `missõesConcluídas / totalMissões` in `[0,1]`, or `null`
  when `totalMissões === 0`.
These are computed in `aggregateScope` alongside `missõesConcluídas` and returned there so
per-project and global both carry them. Existing fields are unchanged.

**R2 — two new Histórico stat tiles.**
WHEN the Histórico tab renders with data, it SHALL show two new stat-cards, inserted **right
after "missões concluídas"** (so the reader sees concluídas → não concluídas → taxa together):
- `missões não concluídas` — value = `missõesNãoConcluídas`.
- `taxa de conclusão` — value = `taxaConclusão` formatted as a **percentage** (e.g. `14%`);
  `sem dados` when `taxaConclusão === null`.
Both SHALL carry a visible **ⓘ** tip via new `HISTORICO_TERMS` entries (reuse `renderInfoTip`).
Definitions (pt-BR, plain language):
- não concluídas: `"missões que ainda não chegaram a Done (em Intake, Needs Human, etc.)"`
- taxa de conclusão: `"percentual de missões concluídas sobre o total (concluídas ÷ total)"`
CRITICAL: `cardValues` is positional against `HISTORICO_TERMS`. Adding two terms means adding
two `cardValues` entries **in the same positions**, and every downstream card stays aligned
with its definition. A test MUST pin this alignment (see V3).

**R3 — lead-time "—" self-explains (no bare-dash ambiguity).**
- The per-mission table's **Lead time** `<th>` SHALL carry a visible ⓘ tip (or, if a header
  tip is structurally awkward, an inline note is acceptable) whose text explains: lead time =
  da criação até Done; "—" = missão ainda não concluída.
- WHEN ≥1 mission in the table has `leadTime === null`, a note SHALL render beneath the table
  (a `<p class="muted lead-nota">…`), stating the count, e.g.:
  `"N missões ainda não concluídas não têm lead time — ele é medido da criação até o Done."`
  The N SHALL equal the number of null-leadTime rows (which equals `missõesNãoConcluídas` for
  the global scope). WHEN zero rows are null, the note SHALL NOT render.

**R4 — determinism & rules.** No `Date.now()`/`Math.random()` in the render path. No product
literals in `scripts/**` (`scripts/project-profile.test.mjs:370` meta-test stays green). All
scripts keep the `isMain` guard + soft-fail semantics. Tests are `node:test` +
`node:assert/strict`.

## Verification (the gate is necessary, NOT sufficient)

**V1** `pnpm test` green (from repo root). New tests included in the `pnpm test` globs.

**V2 — history.test.mjs:** assert aggregate() returns `totalMissões`, `missõesNãoConcluídas`,
`taxaConclusão` with correct arithmetic on a seeded fixture (e.g. 3 slugs, 1 Done →
total 3, não 2, taxa 1/3); assert `taxaConclusão === null` and `missõesNãoConcluídas === 0`
when there are zero rows; assert the identity `missõesConcluídas + missõesNãoConcluídas ===
totalMissões` on the fixture.

**V3 — board-report.test.mjs:**
- The rendered Histórico HTML contains a card labelled `missões não concluídas` and one
  labelled `taxa de conclusão`, each with a `class="info-tip"` affordance.
- **Alignment guard:** `cardValues.length === HISTORICO_TERMS.length` (or an equivalent
  assertion that each term's definition lands on its intended value) — the positional coupling
  is pinned so a future insert can't silently misalign definitions.
- `taxa de conclusão` renders as a `%` for a non-null fixture and `sem dados` for the null case.
- The lead-nota renders with the right count when null rows exist, and is absent when none do.
- The Lead time `<th>` carries an `info-tip` (or the agreed inline explanation).

**V4 — rendered-DOM probe (held-out validator, GLM-5.2 Playwright), per
`projects/factory/validation.md`.** Serve the rendered factory board on `127.0.0.1:8799`,
drive at **390×844** and **1440×900**:
- Both new tiles are **visibly present** with their values; their ⓘ reveals the definition on
  hover (desktop) and tap (mobile) — a bare `title=` is an automatic FAIL.
- The lead-nota is visible beneath the table; the Lead time column's affordance reveals its
  explanation. No bare wall of "—" without an accounted-for explanation on the page.
- `browser_snapshot` is the assertion surface; a screenshot backs the human-legibility call.

## Out of scope
Client-view page, VPS republish (coordinator does that after André's OK), M6 routing.
