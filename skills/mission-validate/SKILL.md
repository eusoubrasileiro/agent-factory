---
name: mission-validate
description: VALIDATOR seat of the AmiticIA factory. With fresh, adversarial context that never saw the worker's code, prove a finished mission against its contract — the project's deterministic gate plus its behavioral probes — and return a PASS/FAIL verdict. Use after /mission-build, when Andre says "validate mission <slug>", "/mission-validate <slug>", or "check the work".
---

> **Engine runs from the factory repo** (`tools/factory`): run `node scripts/*.mjs` there with `--project <project>`; dossiers are `missions/<project>/<slug>/`. The worker edits product code in the product worktree; dossier commits land in the factory repo, never in the product repo.
>
> **Per-project facts live in the profile, never in this skill.** Gate commands:
> `projects/<project>/project.json → gate[]`. Behavioral probes, test numbers and
> recipes: `projects/<project>/validation.md`. Read both before you start.

<what-to-do>

You drive the **validator** seat. You are adversarial **by design**: you did not
write this code and you have not read the worker's reasoning. You only get the
contract and the diff. Your job is to try to make "done" fail.

## 1. Take ONLY the contract and the diff
- Read `missions/<project>/<slug>/contract.md`.
- Read the mission diff: `git -C <worktree> diff <trunk>...HEAD` (trunk and branch
  prefix come from the profile). Do **not** read the worker's handoffs, the PRD, or
  the feature specs' "context seed" — you check behavior, not intent.

## 2. Run the deterministic gate (the wall)
The project's `gate[]` array is the authoritative command list. Read it, then run
every command in order with `cwd` = the mission worktree:
```bash
node -p "require('./projects/<project>/project.json').gate.join('\n')"   # from the factory root
```
Any non-zero exit → **FAIL** immediately; report which command and stop.
The engine never hardcodes these commands — a gate that is wrong for a project is
a bug in that project's profile, not in this skill.

## 3. Run the contract assertions against LOCAL
Read `projects/<project>/validation.md`. It names the proof mechanism for each kind
of assertion in that project — which E2E command covers data/backend, which MCP
probe covers chat, which UI target playwright drives, and any project-specific
landmine (test numbers that must never be a live customer's, probes that must be
serialized, harnesses that do not run in dummy-env worktrees).

For each assertion in the contract, run its proof on the **local** stack, following
that playbook. An assertion with no green proof → that assertion FAILS.

### 3a. Optional — run the validator on a held-out agent seat
The validator seat may run on a **separate, held-out agent** (a fresh session that
never saw the worker's context). The proven default is a caged **`claude-worker`**
seat (D-19/D-21: containment demonstrated against Write + recognized shell forms).
Give it ONLY `contract.md` + the diff, and have it emit through `verdict.mjs`:
```bash
node scripts/claude-worker.mjs --dir <worktree> --model claude-sonnet-5 \
  --project <project> --allow-anthropic --creds /dev/null \
  --slug <slug> --metric-seat validator \
  --prompt "You are the held-out validator. Read ONLY missions/<project>/<slug>/contract.md and the diff (git diff <trunk>...HEAD). Prove every assertion on LOCAL, run the project's gate, then emit the verdict via: echo \"\$JSON\" | node scripts/verdict.mjs record <slug> --project <project>."
```
(A caged Sonnet seat on the operator's Anthropic session — `--creds /dev/null` forces
that fallback rather than a stale z.ai base URL. Set `FACTORY_WORKTREE_MARKER` if the
worktree layout isn't the default.)

There is no other external driver: the opencode fallback was retired (D-63).
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
  `missions/<project>/<slug>/validate.log`, and enforces the 3-round bound in code
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
- Each round is logged to `missions/<project>/<slug>/validate.log` by
  `node scripts/verdict.mjs record <slug>` (step 4) — the recorder counts
  rounds and enforces the 3-round bound in code, so the loop is resumable cold and
  machine-checkable (`node scripts/verdict.mjs status <slug>`: exit 0 PASS,
  1 FAIL/none, 2 exhausted).

## 5. Report to Andre, then ratify on his word
Give Andre a tight verdict: PASS/FAIL, the assertion table with green/red, and —
if PASS — that the mission is ready for his **ratification → merge → tag →
upstream**. You never push or deploy; that is Andre's gate.

**RUN the emitter — not optional** (this touchpoint is the "ratify" attention unit in
the KPI; each fix-round debug you drove in HG-6 must also have recorded an
`intervention`):
`echo '{"seat":"orchestrator","type":"touchpoint","detail":"verdict-report"}' | node scripts/metrics.mjs record <slug> --project <project>`

- A PASS sits at `Needs Human (gate:ratify)` — it is **not** `Done` until the owner
  ratifies. On his word, close the loop with the recorder, which is the only thing
  that moves the card to `Done`:
  ```bash
  pnpm mission:ratify <slug> --project <project>
  ```
  Ratify only after the PASS verdict is recorded (`node scripts/verdict.mjs status
  <slug> --project <project>` exits 0). This step is the missing half of the loop:
  `verdict record` (validator) → `mission:ratify` (owner, via you) → `Done`.

## Rules
- Fresh context every time — if you reviewed a prior mission, start clean.
- Prefer the deterministic gate; behavioral probes cover what tests can't (the bot
  replied nonsense, the WABA link is broken, the UI is unusable).
- 99% is a failing grade on anything security/RLS — adversaries retry forever.
- **Telemetry:** record `false_idle` when an idle alarm proves false, and
  `intervention` when the orchestrator must debug — `echo '{"seat":"validator","type":"false_idle","detail":"..."}' | node scripts/metrics.mjs record <slug> --project <project>` (v2 §3.4).

</what-to-do>
