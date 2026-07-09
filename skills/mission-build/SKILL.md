---
name: mission-build
description: WORKER driver of the AmiticIA factory. Implement an approved mission's feature specs one at a time in clean, isolated context (dispatch worktree, TDD, commit, structured handoff). Use after Andre approved a mission's plan+contract, when he says "build mission <slug>", "/mission-build <slug>", or "run the workers". Never runs without an approved contract.
---

> **Engine runs from the factory repo** (`tools/factory`): run `node scripts/*.mjs` there with `--project <project>`; dossiers are `missions/<project>/<slug>/`. The worker edits product code in the product worktree; dossier commits land in the factory repo, never in the product repo.
>
> **Per-project facts live in the profile.** The gate commands a worker must pass
> are `projects/<project>/project.json → gate[]`; the isolation command is its
> `dispatch` field. This skill never names a product's commands.

<what-to-do>

You drive the **worker** seat. Workers implement; they do not plan and they do not
judge their own work. Precondition: `missions/<project>/<slug>/contract.md` exists
and Andre approved the plan. If not, stop and route to `/mission-plan`.

## 1. Order the features
- Read `plan.md`. Build a dependency order. Features with no dependency on each
  other MAY run in parallel; anything with a real dependency runs **serial** so
  each worker inherits a green tree.
- **External-seat concurrency cap: 10.** The z.ai coding plan allows at most ten
  concurrent `glm-5.2` sessions. Beyond that the provider rejects the extras — it
  does not queue them for you. Its usage limit is also a **5-hour rolling window**,
  not a credit balance, so ten parallel seats drain it five times faster than two.
  Sizing a fan-out is a spend decision, not a throughput one.

## 2. Isolate
- Materialize an isolated worktree for the mission with the project's `dispatch`
  command (`projects/<project>/project.json → dispatch`, `{slug}` substituted).
  It creates the branch `<branchPrefix><slug>` and, for a product repo, usually
  allocates unique ports and a scratch DB too. All worker work happens there —
  never in the main tree, never on the trunk branch.
- Run `pnpm board:sync <slug>` so the card tracks into `Building`.

## 3. Run each worker with CLEAN CONTEXT
For feature `NN`, spawn a worker (an `Agent`/`claude -p`, Sonnet is the default
seat) whose context is **only**:
- `missions/<project>/<slug>/features/NN.md`
- `constitution.md` (the factory's, broadcast to every seat)
- the product repo's own agent instructions (`CLAUDE.md` / `AGENTS.md`)

Give it this instruction shape:
> "Implement feature NN exactly as specified. TDD: write the failing test first.
> Touch ONLY the files your spec lists. Do NOT read the PRD, sibling specs, or
> `docs/`. If you need something not in your spec, record it under
> `unmet_knowledge` and proceed as best you can. When every gate command passes
> (the list is in the spec), commit to the mission branch and write
> `features/NN.handoff.md` from the handoff template. Do NOT push, do NOT deploy."

Paste the project's `gate[]` commands into the worker's spec — a worker seat never
reads the profile itself, and an external seat may not even be able to.

### 3a. Optional — route a worker to the external agent seat
The default worker runs on the operator's own Claude session. To spend no Anthropic
tokens on mechanical work, a worker MAY instead run on the **external seat**: Claude
Code pointed at a third-party Anthropic-compatible endpoint (z.ai → GLM, on a flat
subscription). Same spec, same clean-context rules; only the executor changes:
```bash
node scripts/claude-worker.mjs --dir <worktree> --model glm-5.2 \
  --slug <slug> --project <project> --metric-seat worker --timeout 2700000 \
  --prompt "Read missions/<project>/<slug>/features/NN.md and execute it exactly, TDD, then run the pre-commit gate and commit."
```
The seat is **caged**: a fresh `settings.external.json` is rendered from the project
profile at every spawn, and the driver refuses to run without it. It also refuses to
run against `anthropic.com` — that would silently bill real money for a seat that
must be flat-rate.

`opencode-worker.mjs` is the **fallback**, for providers with no Anthropic-compatible
endpoint. Its cage (`cage-opencode.mjs`) is real but its containment is not yet
proven (D-17); prefer the Claude seat.

**If a builder returns nothing, check the rate limit before anything else.** z.ai
answers a spent 5-hour window with `429 rate_limit_error` (code 1308) naming the exact
reset time. `opencode` swallows it — zero bytes on stdout AND stderr, a silent
30-minute hang that looks like a slow build. `claude -p` reveals it only under
`--print-logs`. Do not debug the spec, the worktree, or the model until the provider
answers `200`.

#### Want a Sonnet worker instead of GLM?

The same driver runs it, still caged. It costs Anthropic tokens (or your plan quota)
instead of the flat z.ai plan, so you must say so out loud:

```bash
node scripts/claude-worker.mjs --dir <worktree> --model sonnet \
  --slug <slug> --project <project> --allow-anthropic --timeout 2700000 --prompt "..."
```

Without `--allow-anthropic` the driver refuses, because a missing `ANTHROPIC_BASE_URL`
silently falls back to Anthropic — and a seat that was supposed to be flat-rate would
quietly bill you. With no credentials at all, `claude -p` uses your own logged-in
session, which is usually what you want.

**The trap, if you ever A/B Sonnet against GLM.** Do NOT pass `--model sonnet` while
`ANTHROPIC_BASE_URL` points at z.ai. Claude Code resolves the `sonnet` alias through
`ANTHROPIC_DEFAULT_SONNET_MODEL`, which z.ai's own setup guide tells you to set to
`glm-5.2`. You would run GLM twice, see two nearly identical scorecards, and conclude
the models are equivalent. Compare seats by pointing each at its own endpoint, and
read `metrics.jsonl` for tokens/feature — never `total_cost_usd`, which is fiction on
a flat plan (D-13).
Always pass `--timeout` explicitly. Both drivers now stop a timed-out seat with
SIGTERM, a 30-second grace, then SIGKILL — but the default window is 30 minutes, and
a real feature often needs more.

Always pass `--project` too. It routes the worker's telemetry to
`missions/<project>/<slug>/metrics.jsonl`. Omit it and the recorder falls back to
the sole profile — or, once a second profile exists, to a synthesized `default` —
and the KPI numbers for the run land in another project's tree. `metrics.mjs` now
warns on stderr when it has to invent a mission dir; do not ignore that warning.

The external seat is **still governed by the harness**: it is confined to the
dispatched worktree, dispatched with `--seat external` so its `.env` holds only dummy
values, caged so it cannot edit a Critical File, and its output only counts once the
project's `gate[]` is green — the orchestrator re-runs the gate itself before
accepting the commit.

Honest limit: the cage stops the seat's *edit tools*. It does not stop a subprocess
reading a file (`python3 -c "open('.env').read()"`). Real secrets stay out of the
worktree; that is what contains them, not the deny rule.

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
