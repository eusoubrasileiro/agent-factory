---
name: mission-build
description: WORKER driver of the WaHub factory. Implement an approved mission's feature specs one at a time in clean, isolated context (dispatch worktree, TDD, commit, structured handoff). Use after Andre approved a mission's plan+contract, when he says "build mission <slug>", "/mission-build <slug>", or "run the workers". Never runs without an approved contract.
---

> **Engine runs from the factory repo** (`tools/factory`): run `node scripts/*.mjs` there with `--project wahub`; dossiers are `missions/wahub/<slug>/`. The worker edits product code in the wahub worktree; dossier commits land in the factory repo, never wahub.

<what-to-do>

You drive the **worker** seat. Workers implement; they do not plan and they do not
judge their own work. Precondition: `missions/wahub/<slug>/contract.md` exists
and Andre approved the plan. If not, stop and route to `/mission-plan`.

## 1. Order the features
- Read `plan.md`. Build a dependency order. Features with no dependency on each
  other MAY run in parallel; anything with a real dependency runs **serial** so
  each worker inherits a green tree.

## 2. Isolate
- Materialize an isolated worktree for the mission: `pnpm dispatch <slug>`
  (unique ports + DB, branch `agent/<slug>`). All worker work happens there —
  never in the main tree, never on `main`.
- Run `pnpm board:sync <slug>` so the card tracks into `Building`.

## 3. Run each worker with CLEAN CONTEXT
For feature `NN`, spawn a worker (an `Agent`/`claude -p`, Sonnet is the default
seat) whose context is **only**:
- `missions/wahub/<slug>/features/NN.md`
- `factory/constitution.md`
- `AGENTS.md`

Give it this instruction shape:
> "Implement feature NN exactly as specified. TDD: write the failing test first.
> Touch ONLY the files your spec lists. Do NOT read the PRD, sibling specs, or
> `docs/`. If you need something not in your spec, record it under
> `unmet_knowledge` and proceed as best you can. When green
> (`pnpm test`, `tsc --noEmit`, `pnpm lint`, `pnpm quality-gate` all pass),
> commit to the mission branch and write `features/NN.handoff.md` from the
> handoff template. Do NOT push, do NOT deploy."

### 3a. Optional — route a worker to the external agent seat
The default worker is a Claude seat. To save Anthropic tokens on mechanical work,
a worker MAY instead run on an **external agent** (opencode → e.g. GLM 5.2 on a
subscription plan). Same spec, same clean-context rules; only the executor changes:
```bash
pnpm factory:opencode --dir .claude/worktrees/<slug> --model zai-coding-plan/glm-5.2 \
  --slug <slug> --metric-seat worker \
  --prompt "Read missions/wahub/<slug>/features/NN.md and execute it exactly, TDD, then run the pre-commit gate and commit."
```
The external agent is **still governed by the harness**: it is confined to the
dispatched worktree, and its output only counts once the deterministic gate
(`pnpm test`, `tsc --noEmit`, `pnpm lint`, `pnpm quality-gate`) is green — the
orchestrator re-runs the gate itself before accepting the commit. This is opt-in;
it never changes the default Claude seat.

## 4. Between features
- Confirm the worker committed and the tree is green before starting a dependent
  feature. Collect each `NN.handoff.md`.
- If a worker reports a blocker it cannot resolve within scope, **do not let it
  improvise outside scope** — surface it to the orchestrator (`/mission-plan`) for
  a follow-up feature or a spec fix.

## 5. Hand to the validator
- When all features are committed green locally, the mission branch is ready for
  `/mission-validate <slug>`. Summarize for Andre: features done, any
  `unmet_knowledge` collected, and that it is awaiting validation.
- Run `pnpm board:sync <slug>` so the card tracks into `Validating`.

## 6. Fix rounds — keep the PR timeline honest
Only when `missions/<project>/<slug>/PR` exists (the projection opened a draft PR;
see `scripts/pr-record.mjs`), the **orchestrator** — never the worker, whose prompt
still forbids pushing — pushes after each fix-round commit so the PR shows the
validate→fix history rather than one squashed blob:

```bash
git -C <repoRoot> push origin agent/<slug>
```

No PR marker (projection off, or `gh` was down) → skip it; the mission ships from
disk regardless. Never force-push a mission branch.

## Rules
- Local-first: workers prove green against LOCAL only. Upstream is Andre's call
  after validation.
- A worker never edits a Critical File unless its spec named it.
- Keep workers small and serial-on-dependency; correctness compounds, speed is
  secondary.
- **Telemetry:** record `escalation` / `worker_death` / `phase_start` / `phase_end`
  events per feature — `echo '{"seat":"orchestrator","type":"phase_start","detail":"NN"}' | node scripts/metrics.mjs record <slug>` (v2 §3.4).

</what-to-do>
