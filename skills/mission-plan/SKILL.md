---
name: mission-plan
description: ORCHESTRATOR seat of the WaHub factory. Turn a feature intent into a mission — brief + plan + validation contract + scoped feature specs — then get Andre's one approval before any code. Use when Andre says "plan a mission", "new feature", "/mission-plan <intent>", or hands you a feature idea to build. Reads the PRD; workers/validators never do.
---

> **Engine runs from the factory repo** (`tools/factory`): run `node scripts/*.mjs` there with `--project wahub`; dossiers are `missions/wahub/<slug>/`. The worker edits product code in the wahub worktree; dossier commits land in the factory repo, never wahub.

<what-to-do>

You are the **orchestrator**. You convert intent into a runnable, verifiable
mission. You read the product vision; the workers and validators you set up will
NOT — you distil it down for them. Follow these steps in order.

## 1. Capture intent (just the seed)
- Take Andre's one-line (or paragraph) intent — that is ALL he owes you at intake.
  Pick a short kebab `<slug>`. Do **not** ask him to write the brief; **you** write
  it (step 3), he ratifies it. He directs and ratifies; he never authors.

## 2. Read down from the product truth (orchestrator-only)
- Read `docs/prd/nexus-crm.md`, `CLAUDE.md`, `CONTEXT.md`, and the **relevant**
  code (routes/services/schema the feature touches). Use `Explore`/grep — do not
  dump the whole repo into context.
- This is the ONLY seat allowed to read the PRD. Everything you learn that a
  worker needs, you will paste into that worker's feature spec as a context seed.
- Read BEFORE the grill (step 3): the code is what tells you *where* the intent
  is under-specified, so your questions land on real decisions, not fishing.
- **Reality check vs HEAD (mandatory, before the grill):** for every scope claim
  in the emerging brief, verify against the repo as it exists NOW — `git log
  --oneline -20` + reading the named files/routes: does the feature already
  exist? do the named surfaces still exist? Attach a confirmed/contradicted
  table to the brief; a contradicted claim means re-scope before Andre ever
  sees it. (v2 §3.1 — briefs drift from moving codebases.)

## 3. Grill Andre → then write the brief FOR him
The intake is an **active interrogation**, not a form he fills. Having read the
product truth, you now know the decisions this feature forces. Extract them:
- **Reflect first.** State back, in ONE sentence, what you think he wants and who
  it serves — force a yes/no. A wrong reflection is the cheapest thing to catch here.
- **Grill one question at a time.** Ask only **decision-forcing** questions — the
  ones where a different answer changes what gets built or carries business/risk
  consequence (scope boundary, who reads it, what "done" looks like, a hard
  constraint, a trade-off he must own). Each question **carries your recommended
  default** so he can answer "sim" and move on. Never ask him engineering choices
  (architecture, libraries, test structure) — you own those; decide them silently.
  Cover his blind spot: surface business/risk trade-offs as a short yes/no, never
  as authorship. Stop as soon as the answers are unambiguous — don't pad the grill.
- **Then write** `missions/wahub/<slug>/brief.md` from `templates/brief.md`
  FROM his answers (WHAT + WHY only, ≤ 1 page). Show it back; his "sim" ratifies it.
  This ratified brief — not anything he hand-wrote — is the owner-seat artifact.

## 4. Derive the validation contract FIRST (before the plan's HOW)
- Create `contract.md` from the template. Write the **assertions from the brief's
  intent** — observable, testable behavior. Pick the proof mechanism per assertion:
  - backend/data → `pnpm test:e2e:supabase` (local, real auth+RLS+realtime) or `pnpm test:e2e`
  - chat / WABA → **`whatsapp` MCP** probe (send real message → assert effect)
  - frontend / UI → **`playwright` probe** (drive the live Lovable app) + keep its build green
  - always → the house-standard gate (`quality-gate`, tests, tsc, lint)
- The worker will NOT see these run. You own "done", not the worker.
- Once `brief.md` + `contract.md` both exist, `pnpm board:sync <slug>` reflects
  the card as `Needs Human (gate:approve-plan)` — the board, not you, tells Andre
  a plan is waiting on him.

## 5. Build the plan (scope tree) and decompose
- Create `plan.md`: milestones → features, with a dependency column.
- For each feature, create `features/NN.md` from the template. Each must be
  **self-contained, ≤ ~1300 tokens, list the exact files it may touch, carry its
  own assertions, and paste the context seed**. No sibling cross-refs. No PRD.
- Run the **coverage check**: every contract assertion is carried by ≥ 1 feature.
  Fill the coverage table in `plan.md`. If an assertion has no feature, the plan
  is incomplete — fix it before proceeding.

## 6. The ONE approval gate — present to Andre
- Show Andre `plan.md` + `contract.md` (not every feature spec — the summary).
  Any strategic question still open goes one at a time, with your recommendation.
- On his approval, the mission is cleared for `/mission-build`. If a real,
  hard-to-reverse trade-off was decided, append one line to `factory/decisions.md`.
- On approval, write the one-line marker `missions/wahub/<slug>/APPROVED`
  (content: `approved <YYYY-MM-DD>`) and run `pnpm board:sync <slug>` — the card
  moves to `Building`'s precondition state.

## Rules
- You orchestrate in prose/skills, not a state machine. Keep judgment here; push
  determinism to the gate.
- Never write product code in this seat. You produce specs and contracts only.
- Serialize features only on a real dependency; mark independents as parallelizable.
- **Telemetry:** record a `touchpoint` event each time Andre is engaged (intent
  capture, the grill, the approval gate) — `echo '{"seat":"orchestrator","type":"touchpoint","detail":"..."}' | node scripts/metrics.mjs record <slug>` (v2 §3.4).

</what-to-do>
