# Plan B — `board-legibility`: a board Andre can actually read (iteration 4, the honest one)

> **Audience: an Opus coordinator agent leading builder seats.** Execute and verify; when
> this doc and reality conflict, STOP and escalate to Andre. Re-verify every file:line
> against main first. **Depends on Plan A** (`plan-A-ship-truth-2026-07-11.md`): F2 here
> renders the `ships.jsonl` ledger A-F1 creates — land A-F1 first, or stub behind
> "ledger absent ⇒ omit the merge column" (never fake it).
>
> **Provenance.** 2026-07-11, Fable 5 planner; findings from a Sonnet board-consistency
> auditor (renderer code + last-published `dist/factory-board/wahub/index.html` + the
> canonical `standards/factory-process.md`) and an Opus intake-lifecycle tracer (full
> IN-NN → backlog → mission → git chain reconstruction). E-doc §0/§0.1/§0.2/§7 binding.

## Why (business)

This is board iteration 3 and Andre — the primary reader — calls it confusing and not
useful; Tenant A reads it instead of asking status. Measured defects, all in production
output today:

1. **Intake→outcome traceability is 0% functional on the published board**: header says
   "18 requisitos captados · 0 despachados"; all 18 rows badge `não despachado`,
   including four whose own lifecycle column says `Landed` (IN-01/02/07/08). Two causes:
   the stale publish (fixed by Plan A-F3) and the chain builder ignoring the one field
   that records the answer (F1 below).
2. **`Needs Human` is one lane hiding three unrelated situations** — `gate:approve-plan`
   (pre-build, awaiting plan OK), `gate:ratify` (built, validated, PASS — awaiting merge
   blessing), `gate:escalated` (3 FAILs). 14 missions piled in one lane, urgency
   indistinguishable (`board-sync.mjs:41-44`; lanes `board-report.mjs:392-400`).
3. **"Intake" means two things on one page** — a mission lane (dossier without
   `brief.md`, `board-sync.mjs:136`) and the client-capture tab
   (`New/Distilled/Ratified/Landed`, `intake-report.mjs:34`). Lane-"Intake" cards show
   millions of seat tokens spent (`bot-bulk-enable` 1.69M) — contradicting "not started".
4. **Three status vocabularies rendered identically**: mission-derived state, intake
   lifecycle, and hand-typed PRD `Situação` prose normalized into mission words
   (`board-import-backlog.mjs:108-121`) — a "done" someone typed in markdown is visually
   identical to a verdict-derived Done.
5. **`factory-process.md` and the board disagree**: doc's `backlog`/`parked`/
   `ready-for-agent`/`in-review` never appear; board's `Intake` lane, gate badges,
   Agentes/Histórico tabs, Corpo A–D grouping appear nowhere in the doc. The canonical
   process doc describes a board that doesn't exist.
6. **Internal contradictions render unflagged**: `sdr-flow-0703` shows
   `gate:approve-plan` (not approved to build) AND `2/2` features with handoffs — one
   card, both claims, no warning.

## F1 — repair the chain (requirement → mission → merge), the missing view

The chain builder `buildChain()` (`intake-report.mjs:333-345`) and the mission join
(`board-report.mjs:48,58,66,77-80,301`) lose threads four ways. Fix all four:

- **F1-a Read `landedIn`.** The intake table's `landedIn` column exists, is parsed and
  editable (`intake-report.mjs:231`, `intake-server.mjs:234`) and is **never read by any
  renderer**. Make it a first-class chain edge: intake → (citedIds ∪ landedIn) → mission.
- **F1-b Tolerant Requirements parser.** `parseRequirementsLine` splits on commas and
  requires bare `/^[A-D]\d+$/`; `**Requirements:** D5 (Mineração → runtime) · …` drops
  D5 entirely, so IN-45's chain dead-ends while `coex-history-mine` is partly merged.
  Fix: extract all tokens matching `\b([A-D]\d+|IN-\d+)\b` anywhere in the line.
- **F1-c Accept the IN- namespace.** `gold-eval-viewer` (MERGED) and
  `gold-eval-prompt-visibility` both declare `**Requirements:** IN-22`; the join
  silently discards non-`A-D` ids, so a shipped mission is invisible from the intake it
  served. IN- tokens join directly to intake rows (skipping the PRD hop).
- **F1-d Collisions are one-to-many.** `reqToMission` keeps first-alphabetical
  (`board-report.mjs:301`): C8 → `bot-ask-city` (never built a branch) while
  `tenant-a-config-leak` (C8, **merged PR #54**) is hidden. Make it req → mission[]; render
  all, ordered by strongest evidence (merged > PASS > building > dossier-only).
- **F1-e Silent drops become visible.** Any Requirements token that matches nothing
  renders as an explicit `⚠ ref não resolvida: <token>` chip on the mission card —
  the current failure mode ("row renders with an empty chain") is invisible by design.

**Chain terminal = git truth**: when Plan A's `ships.jsonl` has the slug, the chain ends
in `merged <sha> (PR #NN)`. Acceptance is the real data: after F1 + A-F1 backfill +
republish, **IN-31→C8→tenant-a-config-leak→PR #54, IN-39→C7→contact-intent-label→PR #52,
IN-41→B5→lead-created-date→PR #56, IN-44→D4→contact-name-backfill→PR #55,
IN-45→D5→coex-history-mine→5868b59, IN-22→gold-eval-viewer→merged** all render as
complete chains, and the header dispatch count is non-zero. These six are the regression
fixtures — encode them as renderer tests with a frozen copy of today's real sources.

## F2 — split `Needs Human` into its three real meanings

Three visually distinct sub-lanes (or one lane, three loud badge colors + sort order):
`Aprovar plano` (pre-build) · `Ratificar merge` (PASS, done-pending-blessing) ·
`Escalado` (3 FAILs, needs thought). Header shows the three counts separately — "14
Needs Human" becomes e.g. "5 para aprovar · 7 para ratificar · 2 escalados", which is an
actionable to-do list instead of a blob. Keep `deriveMissionState` untouched where
possible — this is presentation; the gate reason already exists (`board-sync.mjs:41-44`).

## F3 — end the "Intake" collision + honest lane semantics

- Rename the mission lane to **`Sem contrato`** (dossier exists, no brief/contract yet);
  the capture tab keeps "Intake". A lane card that already carries `stats.json` spend
  additionally shows a `trabalho iniciado` marker — never "not started" next to 2M tokens.
- Add the process-doc states the board lacks: `parked/wont-do` (from an explicit dossier
  marker or PRD Situação) so abandoned work stops squatting in active lanes; the doc's
  `backlog` maps to undispatched PRD rows — label the Requisitos tab as exactly that.

## F4 — one vocabulary, declared sources

- Every badge carries a source glyph/tooltip: `verdict` (derived), `PRD` (hand-typed
  prose), `intake` (lifecycle column). A viewer can now tell a real Done from a typed
  "done".
- **Reconcile `standards/factory-process.md` §2-3 with reality** [coordinator-seat —
  standards repo is outside the cage]: one mapping table (doc state ⇄ board lane ⇄
  deriveMissionState source), document the Agentes/Histórico/Intake tabs and gate
  sub-states, mark `ready-for-agent`/`in-review` as merged into their real equivalents.
  The doc should describe the board that exists; the board should use the doc's words.
  Propose the final vocabulary to Andre as a one-screen table BEFORE renaming lanes
  (naming is product surface — his call, see below).

## F5 — trust indicators

- **Staleness banner**: render `dataAsOf` vs `generatedAt` (Plan A-F3 stamps them);
  > 30 min gap ⇒ visible "dados de <time>" banner. The 14-second stale publish that hid
  three days of Andre's intakes must be impossible to miss next time.
- **Contradiction lint**: at render time, flag impossible card combos (approve-plan gate
  + handoffs > 0; Done + no verdict; lane-Intake + stats.json present) with a `⚠` chip.
  Lint, don't hide — the contradiction is information about the pipeline.

## Seats & verification

Renderers (`board-report.mjs`, `intake-report.mjs`, `board-sync.mjs`,
`board-import-backlog.mjs`) + their tests → **caged builder seats**; `templates/**`,
`projects/**`, `decisions.md`, and the standards-repo doc edit → **[coordinator-seat]**.
E-doc §7 ritual in full: contract first (the six real chains above are the contract's
spine), mutation gates (e.g. re-narrow the Requirements regex → IN-45 fixture named-red;
drop the landedIn edge → IN-22 fixture red), suite green before/after, republish and
**eyeball the real board** — the final acceptance is Andre opening factory.example.com
and following one Wednesday intake to its merged PR without help.

## Ratified decisions (2026-07-11 — Andre delegated; recorded in `decisions.inbox.md`)

1. **Language: Portuguese**, matching the existing board and its readers (Andre, Tenant A).
   Lane names ratified: mission-Intake lane → **`Sem contrato`**; Needs-Human split →
   **`Aprovar plano` / `Aprovar merge` / `Escalado`**. The coordinator still commits the
   final vocabulary table into `factory-process.md` (F4) — names above are the decision,
   the table is the documentation.
2. **`Aprovar merge` exists and holds exactly PASS-but-unmerged missions.** Plan A
   ratified MERGED ⇒ Done, so this sub-lane is the actionable queue "validated, waiting
   for someone to merge" — data shows that queue is real (missions sat at PASS for days
   while others merged). Once merged they leave the lane automatically via A-F1.
3. **Keep Corpo A–D** — it is demonstrably the working vocabulary: the decision ledger
   itself references missions by corpo id (D-45 "[C8 / tenant-a-config-leak]", D-46 "[A6 /
   message-origin]", D-47 "[D4 …]"). Document it in `factory-process.md` instead of
   deleting it from the board.
