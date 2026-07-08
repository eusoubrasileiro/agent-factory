---
name: mission-validate
description: VALIDATOR seat of the WaHub factory. With fresh, adversarial context that never saw the worker's code, prove a finished mission against its contract — deterministic gate + local supabase E2E + whatsapp/playwright behavioral probes — and return a PASS/FAIL verdict. Use after /mission-build, when Andre says "validate mission <slug>", "/mission-validate <slug>", or "check the work".
---

> **Engine runs from the factory repo** (`tools/factory`): run `node scripts/*.mjs` there with `--project wahub`; dossiers are `missions/wahub/<slug>/`. The worker edits product code in the wahub worktree; dossier commits land in the factory repo, never wahub.

<what-to-do>

You drive the **validator** seat. You are adversarial **by design**: you did not
write this code and you have not read the worker's reasoning. You only get the
contract and the diff. Your job is to try to make "done" fail.

## 1. Take ONLY the contract and the diff
- Read `missions/wahub/<slug>/contract.md`.
- Read the mission diff: `git -C .claude/worktrees/<slug> diff main...HEAD`
  (or the dispatch branch). Do **not** read the worker's handoffs, the PRD, or the
  feature specs' "context seed" — you check behavior, not intent.

## 2. Run the deterministic gate (the wall)
From the mission worktree:
```bash
pnpm quality-gate            # must exit 0
pnpm test                    # all unit tests
pnpm --filter=@wahub/backend exec tsc --noEmit
pnpm --filter=@wahub/frontend exec tsc --noEmit
pnpm lint
```
Any non-zero exit → **FAIL** immediately; report which and stop.

## 3. Run the contract assertions against LOCAL
For each assertion in the contract, run its proof mechanism on the **local** stack:
- data/backend → `pnpm test:e2e:supabase` (real auth+RLS+realtime) / `pnpm test:e2e`
- chat / WABA → **`whatsapp` MCP**: send a real message to the test number
  (<test-esim-2>, Amiticia 2 / coexistence) and assert the stored/observed effect.
- frontend / UI → **`playwright`**: drive the live Lovable app, assert the visible
  behavior, and confirm the Lovable build is green (don't break the preview).
- calendar / SDR booking → **T5**: after the chat books, assert via the **Google
  Calendar MCP** (`mcp__claude_ai_Google_Calendar__list_events`) that the real event
  exists AND the `Appointment` row's `googleEventId` matches. A green `Appointment`
  row with **no** Google event is a FAIL (silent insert failure). See the T5 recipe
  in `docs/dev/agent-parallel-validation.md`. Serialize T5/T4 — one shared account/number.
- An assertion with no green proof → that assertion FAILS.

### 3a. Optional — run the validator on the external agent seat
The validator seat may run on an **external agent** (opencode → e.g. GLM 5.2) to
save Anthropic tokens. A fresh opencode session is genuinely held-out — it never
saw the worker's context. Give it ONLY `contract.md` + the diff, and have it emit
through `verdict.mjs` (below):
```bash
pnpm factory:opencode --dir .claude/worktrees/<slug> --model zai-coding-plan/glm-5.2 \
  --slug <slug> --metric-seat validator \
  --prompt "You are the held-out validator. Read ONLY missions/wahub/<slug>/contract.md and the diff (git diff main...HEAD). Prove every assertion on LOCAL, run the deterministic gate, then emit the verdict via: echo \"\$JSON\" | node scripts/verdict.mjs record <slug>."
```
**A weaker validator model must not be trusted blind:** the orchestrator
independently re-runs the deterministic gate and confirms the one non-negotiable
invariant of the mission itself before accepting the verdict. The `verdict.mjs`
schema + 3-round bound still apply — the external seat cannot bypass them.

## 4. Verdict (held-out — the worker never saw this run)
- **PASS** only if every contract assertion is green AND the house-standard gate
  exits 0, all proven locally.
- **FAIL** → list the failing assertion ids + exactly why, in a machine-usable
  shape (assertion id · expected · actual · the proof command that red-ed). Hand
  that back to the **orchestrator**, which drives the **validate→fix loop (HG-6)** —
  you do **not** patch it yourself (held-out integrity: you must never have written
  the code you judge).
- **Emit the verdict through the recorder, not as prose.** Build the verdict JSON
  (schema in `scripts/verdict.mjs`) and pipe it in:
  ```bash
  echo "$VERDICT_JSON" | node scripts/verdict.mjs record <slug>
  ```
  The recorder is the machine record: it schema-validates, appends the round to
  `missions/wahub/<slug>/validate.log`, and enforces the 3-round bound in code
  (round 4+ → exit 2, "escalate to the owner"). Your prose report to Andre (step 5)
  is on top of this, not instead of it.
- The recorder auto-syncs the board — no manual `board:sync` step here. A PASS
  shows as `Needs Human (gate:ratify)`, never `Done`; the owner still ratifies.
- Mine the failure: any gap that caused a miss → suggest an `unmet_knowledge` line
  for the knowledge-engine inbox.

## The validate→fix loop (HG-6 — the ORCHESTRATOR drives this loop; the validator only records verdicts)
A single FAIL is not the end of the mission; it is one turn of a bounded loop the
**orchestrator** runs (never the held-out validator):

```
validate ──FAIL──▶ orchestrator spawns a FIX worker (fresh `claude -p` in the SAME
                   worktree) scoped to ONLY the failing assertions + your FAIL report
            │
            ▼
        fix worker: RED test for the gap first → implement → commit → handoff
            │
            ▼
        re-validate (a FRESH validator seat — clean context again)
            │
   ┌────────┴─────────┐
 PASS                FAIL  ──▶ loop, up to N=3 rounds total
   │                   │
ratify ✋         after N: STOP, escalate to Andre with the persistent red
```

- **Bound it: max 3 fix rounds.** If still red after round 3, stop and escalate to
  Andre — a gap that survives three scoped fixes is a spec/architecture problem, not
  a coding miss, and burning more rounds wastes tokens and hides the real issue.
- Each re-validate is a **fresh** validator seat (never reuse this run's context).
- The fix worker gets ONLY the FAIL report + contract slice — not your full run, so
  it fixes the behavior, not your wording.
- Each round is logged to `missions/wahub/<slug>/validate.log` by
  `node scripts/verdict.mjs record <slug>` (step 4) — the recorder counts
  rounds and enforces the 3-round bound in code, so the loop is resumable cold and
  machine-checkable (`node scripts/verdict.mjs status <slug>`: exit 0 PASS,
  1 FAIL/none, 2 exhausted).

## 5. Report to Andre
Give Andre a tight verdict: PASS/FAIL, the assertion table with green/red, and —
if PASS — that the mission is ready for his **ratification → merge → tag →
upstream**. You never push or deploy; that is Andre's gate.

## Rules
- Fresh context every time — if you reviewed a prior mission, start clean.
- Prefer the deterministic gate; behavioral probes cover what tests can't (the bot
  replied nonsense, the WABA link is broken, the UI is unusable).
- 99% is a failing grade on anything security/RLS — adversaries retry forever.
- **Telemetry:** record `false_idle` when an idle alarm proves false, and
  `intervention` when the orchestrator must debug — `echo '{"seat":"validator","type":"false_idle","detail":"..."}' | node scripts/metrics.mjs record <slug>` (v2 §3.4).

</what-to-do>
