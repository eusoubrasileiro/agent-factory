# Board v5 — two-audience dashboard: Tenant A funnel + André science layer

## Context

The 2026-07-13 adversarial UI audit fixed the presentation layer (per-project scoping,
mobile, a11y — commit `3715108`). André's Fable-seat review then found the **product**
layer broken: the board is operator telemetry wearing stakeholder clothes. Root causes
verified in-repo: **Plan B (board-legibility, `docs/plan-B-board-legibility-2026-07-11.md`)
is only ~20% executed** (F1 landed via `ad0f843`; F2–F5 never dispatched), **26 of 44
missions have no `stats.json`** (starves Agentes + Histórico into "sem dados"), the
**D-30 premise is not real** (VPS has only the `andre` basic-auth user — Tenant A can't log
in), and 5 factory dossiers are mis-filed under `missions/wahub/`.

**Two viewers, two products** (research gate satisfied — amiticia-research 2026-07-14,
confidence high, citations: simonwillison.net/2026/Feb/7/software-factory [StrongDM],
Cole Medin "Google agentic-engineering masterclass" 2026-06-25: *one dashboard system
with role gating; stakeholder view hides internal critique + model names, shows
outcome-level progress*):
- **Tenant A (paying client, non-technical)** — plain-PT funnel: o que pedi → em que pé
  está → o que entrou no ar. Business value: self-serve status = fewer WhatsApp pings,
  client confidence, retention.
- **André (owner/researcher)** — science instrument: model A/B evidence, cost/tokens
  per feature, attention-per-feature, lead time (RUNBOOK §Measure it; Plan A F4/F5;
  precedent D-10 full-38 A/B). Business value: the kill-or-scale decision on the factory.

On our static-HTML + Traefik stack, "role gating" = one renderer codebase producing
**per-role artifacts behind per-role basic-auth routers** — client bytes physically
contain zero operator data (no JS-hiding, no leak path).

## Decisions (delegated by André 2026-07-14 — "you decide everything"; record each in decisions.md)

1. **Tenant A view = funnel + weekly-shipped, nothing else.** Excludes: money, tokens,
   model names, `# Detalhamento técnico` blocks, `business-decision (engagement)` lines.
   **Narrows D-30's published blast radius** — new decisions.md line supersedes it.
2. **Science layer lives ON the board** (enriched Agentes + Histórico tooltips) **plus**
   `pnpm kpi` CLI (Plan A F5). A meter André doesn't see doesn't get read.
3. **Move the 5 mis-filed dossiers now** (`factory-dashboard`, `factory-extract`,
   `factory-live-board`, `factory-secret-min`, `scrumban-board`) + re-tag their
   `history.jsonl` rows `project: wahub → factory`.
4. **Provision `tenant-a` basic-auth only after M5 passes its adversarial leak check**,
   and only on the client router (his creds must not open the operator board).
5. Plan B's already-ratified naming stands: lanes **Sem contrato / Aprovar plano /
   Aprovar merge / Escalado**; Corpo A–D stays; board language Portuguese.
   Plan A's ratified **MERGED ⇒ Done** (with `não ratificado` flag) applies.

## Execution — 4 waves, 8 missions, Opus builder seats

Dispatch mechanics: same as the E1–E6 wave — caged seats via `scripts/claude-worker.mjs
--model claude-opus-4-8 --project factory` (Anthropic session; z.ai window expired).
Mission dossiers under `missions/factory/<slug>/` (contract.md first — TDD §7 ritual:
every guard mutation-tested, `pnpm test` green before/after, no product literals in
`scripts/` — the meta-test at `scripts/project-profile.test.mjs:370` enforces it).
Items marked **[coordinator-seat]** touch `templates/**`, `projects/**`, VPS, or repos
outside the cage — the coordinator does them directly.

### W1 — Data truth (prereq for every view)

**M1 `dossier-relocation`** [coordinator-seat — rewrites tracked data]
- `git mv missions/wahub/{factory-dashboard,factory-extract,factory-live-board,factory-secret-min,scrumban-board} missions/factory/`
- One-off re-tag: rewrite those slugs' `history.jsonl` rows `project → factory`
  (small node script, run once, committed as a scripts/one-off or inline — history.jsonl
  is committed data, so the diff IS the audit trail).
- Regenerate board; verify wahub kanban no longer shows factory slugs (was audit C2/V3-F2).
- decisions.md line (PT).

**M2 `stats-backfill`** [builder seat]
- Run `scripts/mission-stats.mjs` (already idempotent + total; has merged-branch
  fallback via `git log --merges --grep <slug>`) over **all 44 dossiers**, all projects.
- Add a tiny driver `scripts/stats-backfill.mjs` (loops dossiers, calls the existing
  collector, prints coverage table) so this is repeatable, + test.
- Acceptance: stats coverage 18/44 → 44/44 (cells that genuinely can't be recovered
  render "sem dados" with `partial: true` — **absent, never zero-filled**, the E1-d law).
- This alone fixes most of "Agentes so few" + Histórico "sem dados" (audit C6).

### W2 — Board legibility (Plan B F2–F5, spec already written)

**M3 `lanes-legibility`** [builder seat] — Plan B F2+F3, spec at
`docs/plan-B-board-legibility-2026-07-11.md:77-95`
- Split `Needs Human` → three sub-lanes/badges: **Aprovar plano / Aprovar merge /
  Escalado**, three counts in the header ("5 para aprovar · 7 para ratificar · 2
  escalados"). Presentation-only — gate reason already exists (`board-sync.mjs:41-44`,
  lanes `board-report.mjs` LANE_ORDER).
- Mission lane `Intake` → **`Sem contrato`**; card with `stats.json` spend shows
  `trabalho iniciado` marker; add `parked/wont-do` state from dossier marker.
- MERGED ⇒ Done with small `não ratificado` flag (git `branch.merged` already in model).

**M4 `vocabulary-trust`** [builder seat] — Plan B F4+F5 + review Q1/Q4 fixes
- **Tooltips everywhere**: `title=` on every Histórico KPI tile + a `<details>` legend
  ("o que significa cada número") per tab. Every badge carries a source tooltip
  (`verdict`/`PRD`/`intake`) — a viewer can tell a real Done from a typed "done".
- **Staleness banner**: stamp `dataAsOf` in the model; render "dados de <time>" when
  gap > 30 min (Plan A-F3's stamp, folded here).
- **Contradiction lint**: `⚠` chip on impossible combos (approve-plan + handoffs>0;
  Done + no verdict; Sem-contrato + stats.json). Lint, don't hide.
- **Hide the Requisitos tab entirely on PRD-less projects** (same rule Intake already
  follows — fixes André's "empty tab" on `/factory/`).
- [coordinator-seat] reconcile `standards/factory-process.md` §2-3 vocabulary table.

### W3 — Tenant A client view (the only wave that creates customer value)

**M5 `client-view`** [builder seat]
- New pure renderer `scripts/client-view.mjs` (`renderClientView(model)`): reuses the
  intake parse (`scripts/intake-report.mjs`) + `renderIntakeTab`'s data shape, but a
  **client-safe whitelist renderer** — build from what's ALLOWED in, never filter out:
  id, plain-PT summary, status (mapped to 3 client words: **na fila / em construção /
  no ar**), shipped date, + "Novidades da semana" section (missions merged in last 7d,
  by intake title). Zero: model names, tokens, $, tech blocks, engagement lines,
  mission slugs, lane jargon.
- Output `dist/factory-board/cliente/index.html` via `board-autopublish.mjs` (rides the
  existing hash + rsync funnel; content-hash strip rules apply).
- Mobile-first (Tenant A reads on a phone), same self-contained-HTML rules.
- **Mutation gate**: a named test feeds a fixture intake containing every forbidden
  token class and asserts the rendered client HTML contains none of them (leak test =
  the contract). Weakening the whitelist must turn it red.

**M6 `client-routing`** [coordinator-seat — VPS + deploy docs]
- Traefik: second router `PathPrefix(/cliente)` with its own basicauth middleware
  (users `tenant-a` + `andre`); root router keeps `andre` (+`operator` when provisioned).
  Tenant A's creds must 401 on `/factory/`, `/wahub/` — tested with curl.
- Provision `tenant-a` only after M5's leak check passes (Decision 4). Update
  `deploy/DEPLOY-VPS.md` + decisions.md line superseding D-30 scope.

### W4 — André science layer

**M7 `agentes-evidence`** [builder seat]
- Agentes tab → honest A/B evidence table: keep existing `aggregateAgents` columns,
  add **coverage line** ("dados de N/M missões — X sem stats"), per-column definition
  tooltips, and a per-project + global scope note. After M2, cells fill with real data
  (precedent to serve: D-10-style model comparisons at a glance).
- Explicit "—" for unmeasured, never 0 (E1-d law already in aggregateAgents — verify +
  mutation-test it).

**M8 `kpi-attention`** [builder seat + coordinator-seat for `~/.claude` config] — Plan A F4+F5
- `scripts/session-cost.mjs`: sum coordinator token usage from
  `~/.claude/projects/<workdir>/*.jsonl` by day/model (report-only, no daemon).
- Fix the skill metric emitters (skills narrate but never command `pnpm metrics` —
  that's why totals are 5/3/0); grep-assert one emitter per gate (meta-test).
- `pnpm kpi`: per project/window — missions merged (git-derived) · seat tokens ·
  coordinator tokens · attention-per-feature. The artifact that answers "is the factory
  worth it" (RUNBOOK §Measure it graduation rule).
- [coordinator-seat] set `cleanupPeriodDays: 90` in `~/.claude/settings.json` (both
  machines) — the KPI needs ≥30 days of transcripts.

## Files (representative)

- `scripts/board-report.mjs` + test — M3, M4, M7 (lanes, tooltips, banner, lint, tab-hiding)
- `scripts/board-sync.mjs` — M3 (gate-reason → sub-lane mapping if needed)
- `scripts/client-view.mjs` + test (NEW) — M5; reuses `intake-report.mjs` parse, `esc`/`renderInlineRich` patterns
- `scripts/board-autopublish.mjs` + test — M5 (cliente/ output in funnel + hash)
- `scripts/stats-backfill.mjs` (NEW, thin driver) — M2; reuses `mission-stats.mjs` collector
- `scripts/session-cost.mjs` (NEW) + `scripts/metrics.mjs` — M8
- `missions/` + `history.jsonl` — M1 (data move)
- `deploy/DEPLOY-VPS.md`, VPS compose labels — M6
- `standards/factory-process.md` — M4 [coordinator-seat]

## Verification (end-to-end)

1. Per mission: `pnpm test` green (meta-tests incl. zero-product-literals), named
   mutation-red per guard, contract.md before code.
2. **Tenant A acceptance**: adversarial Playwright validator (reuse the 2026-07-13
   3-validator harness, scratchpad `board-audit.cjs`) drives `/cliente/` at 390px +
   1440px and greps rendered DOM for forbidden tokens (`$`, `tok`, model ids,
   `detalhamento`, slugs) → must be zero; plus reads the screenshot to judge "would a
   non-technical person understand this in 10 seconds".
3. **André acceptance** (Plan B ritual): open factory.example.com, follow one Wednesday
   intake to its merged PR without help; Histórico/Agentes cells ≥90% filled post-M2;
   every KPI tile explains itself on hover.
4. **Auth isolation**: `curl -u tenant-a:… https://factory.example.com/wahub/` → 401;
   `/cliente/` → 200. Documented in DEPLOY-VPS.md.
5. Republish via `board-autopublish.mjs` (guarded funnel), verify live mtimes + markers
   over SSH as done for `3715108`.

## Order & risk

W1 → W2 → W3 → W4 strictly (data truth before views; Tenant A sees nothing until the leak
test exists). Highest-risk item is M6 (external-facing) — checkpointed by Decision 4;
everything else is low blast radius (renderers + tests behind the publish guard).
