# HANDOFF — board-banner-lint (F2)

The two M4 trust features that were **claimed in a commit + coordinator summary but
had zero code** (verified: no `stalenessText` / `missionContradictions` /
`data-generated-at` / `chip-contradicao` in `scripts/board-report.mjs`). Both now
exist, written **TDD (failing test first)**, in the two permitted files only.

## What changed (files touched — only these)
- `scripts/board-report.mjs` — implementation.
- `scripts/board-report.test.mjs` — tests.
- `missions/factory/board-banner-lint/HANDOFF.md` — this file.

F1 (ⓘ tooltips), M3 lane logic, M7 Agentes/coverage — **untouched**. `esc()` on every
interpolated reason/age. `node:*` only. No `Date.now()` in server-rendered HTML.

### A — staleness banner (a board opened hours later SAYS it may be stale)
- **A1** `stalenessText(generatedAtMs, nowMs, thresholdMs = 30*60*1000)` → PT
  `dados gerados há <age> — podem estar defasados` when `nowMs - generatedAtMs >
  thresholdMs`, else `null`. Humanize: `min` (<60) → `h` (<24) → `dias`
  (singular `dia`). Pure & deterministic — `now` is a parameter; **no `Date.now()`
  inside the helper**.
- **A2** Banner container `<div id="staleness-banner" ... data-generated-at=""
  role="status" hidden>` at the top of `<body>` (above the tabs). Client JS
  (`boardStalenessCheck`, exposed on `window`) reads `data-generated-at`, falls back
  to the footer `<time datetime>`, computes `Date.now() - generated`, and if over
  30 min fills the slot + unhides (`banner.hidden = false`). Fresh boards show
  nothing.

### B — contradiction lint (⚠ chip on impossible states)
- **B1** `missionContradictions(mission)` → `string[]` of PT reasons for: (1)
  `Done` + no verdict; (2) `gate:approve-plan` + `handoffs > 0`; (3) `gate:ratify`
  + last verdict `FAIL`. Empty array when coherent. Pure; robust to
  null/undefined.
- **B2** A `⚠` chip `class="chip chip-contradicao"` on each contradictory card;
  reasons joined `; ` into both `title` (mouse) and `aria-label` (screen reader),
  `esc()`'d.

## Key design decision (ratify) — empty `data-generated-at`, NOT a baked ISO
The contract literally says `data-generated-at="<ISO>"`. I render it **empty**
(`data-generated-at=""`) and have the client mirror the footer `<time datetime>` at
view time. Reason: `board-autopublish.mjs → stripTimestampLines` strips the
footer/model timestamp lines so **identical state hashes identically**
(`board-autopublish.test.mjs:555`, "root index: hash includes the root HTML"). A
baked ISO in the banner is a **new** timestamp occurrence matched by **no** strip
marker → it would survive the hash → churn republish on every render → **break that
existing green test**. Autopublish is out of my file scope, so I cannot add the
marker. An empty, constant hook is byte-identical across renders → no churn.

The feature behavior is identical: a real stale tab self-reveals (the footer
timestamp is old), and the held-out Playwright probe injects an old
`data-generated-at` + re-runs `window.boardStalenessCheck()` to force-stale.
**If you'd rather bake the ISO**, the matching fix is a one-liner in
`stripTimestampLines` (add `data-generated-at` to its marker list) — left out to
respect scope.

## gateReason — real model values, not the contract shorthand
The contract writes `gateReason === "approve-plan"` / `"ratify"`. The actual model
field (`board-sync.mjs`) carries `"gate:approve-plan"` / `"gate:ratify"`. I match
the **real** values — matching the shorthand would **never fire on actual mission
data**, which is the exact "claimed but never worked" failure this mission fixes.
Pinned by the B1 rule-2 test that asserts a bare `approve-plan` does **not** trigger
the lint.

## Mutation-gate test names (each reverts red if its rule is dropped)
**A1**
- `A1: stalenessText fresh (gap 0) → null (no banner on a just-opened board)`
- `A1: stalenessText at exactly the 30-min threshold → null (strictly-greater)`
- `A1 mutation gate: gap 31 min → non-null warning containing 'defasad' + the age`
- `A1 mutation gate: a fresh board never warns (catches an always-stale regression)` ← the `>=0` / always-stale mutation
- `A1: humanizes the age into h then dias (singular 'dia')`
- `A1: a custom threshold is honored (10 min is fresh at 30, stale at 5)`
- `A1: stalenessText is deterministic — no Date.now() inside the pure helper`

**A2**
- `A2: a staleness banner container sits at the top of <body>, above the tabs`
- `A2: banner is hidden by default and carries data-generated-at + role=status`
- `A2 churn guard: the banner does NOT bake a volatile server timestamp (autopublish hash stays stable)`
- `A2: the board <script> carries the 30-min threshold + client reveal logic`

**B1**
- `B1 rule 1 mutation gate: Done + null verdict → 'concluída sem veredito registrado'`
- `B1 rule 2 mutation gate: gate:approve-plan + handoffs>0 ⇒ plan-pending-but-delivered`
- `B1 rule 3 mutation gate: gate:ratify + last verdict FAIL ⇒ ratify-a-FAIL`
- `B1: a mission hitting multiple rules returns every reason in order (1, 2, 3)`
- `B1: robust to null/undefined/empty mission object (returns [], never throws)`

**B2** (counts RENDERED chips `class="chip chip-contradicao"`, never the `.chip.chip-contradicao` stylesheet rule — the M3 false-red trap)
- `B2 mutation gate: a contradictory card renders exactly one ⚠ chip + the reason`
- `B2: a clean coherent card renders NO chip-contradicao`
- `B2: multiple contradictions join their reasons with '; ' in the chip title`
- `B2: the chip reason is the title AND the aria-label (mouse hover + screen reader)`

## unmet_knowledge[]
- **Tests were NOT executed in-seat.** This seat's permission layer gates every
  `node` / `pnpm` invocation — `pnpm test`, `node --test`, `node --check`, and the
  `--out /tmp/f2.html` smoke all returned *"requires approval"*; only read-only git
  (`status`, `diff`) ran. I could not witness red→green. Correctness rests on a
  line-by-line hand-review of every assertion against the implementation (all traced
  above). **The held-out validator must run `pnpm test`** (expected: the ~20 new
  tests green, all pre-existing green) **and the Playwright probes** (inject an old
  `data-generated-at` on `#staleness-banner` + call `window.boardStalenessCheck()`
  → banner visible with "defasad"; seed a Done + no-verdict mission → ⚠ chip).
- **Commits were NOT made in-seat.** Mutating git (`git add`, `git commit`,
  `git commit -am`) is gated the same way — only read-only git ran. The change sits
  in the working tree of `agent/board-banner-lint` (445 insertions, 0 deletions
  across the two scripts; `HANDOFF.md` + the `brief.md`/`contract.md` dossier are
  untracked). A coordinator/owner should commit when the gate is open: code first
  (`scripts/board-report.mjs` + `scripts/board-report.test.mjs`), then the dossier.
- **The smoke render (`/tmp/f2.html`) was not run** for the same reason. The A2
  node tests assert the same invariants the smoke checks (banner `data-generated-at`
  container present; client `<script>` contains `30 * 60 * 1000`).
- **Whether any real factory mission is currently contradictory is unknown.**
  `missionContradictions` will fire on real `Done` + null-verdict missions (e.g. a
  RATIFIED dossier with no `validate.log`). If the rendered board shows ⚠ chips,
  that is the lint working — verify each is a real contradiction, not a false
  positive.
- **The smoke render (`/tmp/f2.html`) was not run** for the same reason. The A2
  node tests assert the same invariants the smoke checks (banner `data-generated-at`
  container present; client `<script>` contains `30 * 60 * 1000`).
- **Whether any real factory mission is currently contradictory is unknown.**
  `missionContradictions` will fire on real `Done` + null-verdict missions (e.g. a
  RATIFIED dossier with no `validate.log`). If the rendered board shows ⚠ chips,
  that is the lint working — verify each is a real contradiction, not a false
  positive.
