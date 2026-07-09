# AmiticIA Factory — Runbook

Your control panel. The factory turns **a feature intent** into **a validated,
local-green branch you ratify**. Built to run 20–30 features without re-explaining
the machine each time.

> **Two-repo model (post-extraction, 2026-07-08).** The engine + all mission
> data live in the **factory repo** `~/Projects/amiticia/repositories/tools/factory`.
> Run every engine command from there (`node scripts/verdict.mjs …`), passing
> `--project <id>` (default: the sole profile, when there is only one).
> Dossiers live in `missions/<project>/<slug>/`; `history.jsonl`, `.publish.log`
> and `dist/` are at the factory root. The **product code** a worker edits (and
> the `agent/*` branches, `backlog/`, PRD) live in the product repo, resolved
> from the profile's `path`. Dossier auto-commits land in the factory repo — the
> product's git log gains ZERO factory commits.

> **The engine is generic (v2.2, 2026-07-09).** Every per-project fact lives in
> `projects/<id>/` — `project.json` (`gate[]`, `trunk`, `dispatch`),
> `critical-files.json`, `seat.env`, `validation.md`. The engine carries none of
> them, and `scripts/project-profile.test.mjs` fails the build if it ever does.
> To onboard a project, add the directory and run `pnpm test` — do not edit
> `scripts/`. Full contract + runbook:
> [`standards/agent-patterns/software-factory-v2.md` §8](../../standards/agent-patterns/software-factory-v2.md).

> **Caveat — a profile's `path` is relative to the factory root.** Inside an
> engine worktree (`.worktrees/<slug>/`) that root is the worktree, so
> `../../products/<id>` under-resolves and `repoRoot` points at a path that does
> not exist. Engine missions (`--project factory`, `path: "."`) are unaffected.
> Set `FACTORY_ROOT` explicitly if you must resolve a product from inside an
> engine worktree.

## The loop (per feature/mission)

```
  you: intent ──▶ /mission-plan ──▶ brief + plan + CONTRACT + feature specs
                                          │
                                  YOU APPROVE  ✋  (your one gate)
                                          │
                       /mission-build ──▶ serial workers, clean context,
                                          dispatch worktree, TDD, commit, handoff
                                          │
                     /mission-validate ──▶ fresh adversarial check:
                                          quality-gate + local supabase E2E
                                          + whatsapp / playwright / calendar(T5) probes
                                          │
                                  PASS ──▶ YOU RATIFY ✋ ──▶ merge → tag → upstream
                                  FAIL ──▶ validate→fix loop (HG-6): orchestrator
                                          spawns a scoped FIX worker → RE-validate
                                          (fresh seat) → loop, max 3 rounds, then
                                          escalate to you
```

**The validate→fix loop (HG-6).** A FAIL no longer dead-ends at `/mission-plan`. The
orchestrator spawns a fix worker scoped to *only* the failing assertions, re-runs a
**fresh** validator, and loops until green — bounded at **3 rounds**, after which it
stops and escalates the persistent red to you (a gap surviving three scoped fixes is a
spec problem, not a coding miss). The validator stays held-out: it never patches what
it judges. Rounds are recorded and bounded by `scripts/verdict.mjs` — each
verdict is schema-validated and appended to `missions/wahub/<slug>/validate.log`, and
the 3-round bound is enforced in code (round 4+ refuses and escalates), so the loop is
resumable and machine-checkable rather than trusting an agent to count. Full recipe in
`skills/mission-validate/SKILL.md`.

You touch it **three times**: write the intent, approve the plan+contract, ratify
the validated diff. The machine owns the middle.

## Commands

| Step | You type | What happens |
|------|----------|--------------|
| Plan | `/mission-plan <one-line intent>` | orchestrator reads the PRD, writes the mission, asks you a few questions, you approve |
| Build | `/mission-build <slug>` | workers implement each feature spec in an isolated worktree, TDD, commit, handoff |
| Validate | `/mission-validate <slug>` | fresh validator proves the contract against LOCAL; returns PASS/FAIL |
| Ship (your call) | ratify, then `pnpm ship` / push | only after PASS and your ratification |

## The cage (external worker seats)

The external seat runs under a cage rendered from the project's
`critical-files.json` into **opencode's own** `permission` schema — because opencode,
not Claude Code, is the driver we run. It is written fresh at every spawn, **outside**
the worktree, and handed over via `OPENCODE_CONFIG`. The driver **refuses to spawn
without it** (exit 2); `--allow-uncaged` is the deliberate escape hatch.

```bash
node scripts/cage-opencode.mjs print --project <id>       # what the seat will get
node scripts/probe-cage.mjs <worktree> --project <id>     # static: what the cage SAYS (free)
node scripts/probe-cage.mjs <worktree> --project <id> \
     --live -m zai-coding-plan/glm-5.2                    # live: what the cage DOES (costs tokens)
```

**Read this before trusting it.** The static probe proves our renderer. It does not
prove opencode honours the deny — that needs `--live`, which asserts on file hashes
and never on `permission_denials` (which returns empty even when a deny fires).
**The live probe has not been run yet** (decisions.md D-17). Until it has, treat the
cage as installed-but-unproven.

What the cage does and does not do: an `edit` deny stops the agent's edit/write
tools. It does not stop `python3 -c "open('.env').read()"`. Secrets are contained by
the dummy `.env` in the worktree, not by a deny rule.

## Onboarding a project (~1 hour, no engine edits)

```bash
# 1. The profile directory. Four files; nothing else, nowhere else.
mkdir -p projects/<id>

# 2. project.json — id/name/path/prd/trunk/branchPrefix/gate[]/dispatch.
#    gate[] is EXACTLY the repo's pre-commit commands, in order.
#    Any non-zero exit is a mission FAIL.
# 3. critical-files.json — globs an untrusted seat may not edit.
#    Start from the repo's own "Critical Files" list in its CLAUDE.md.
# 4. seat.env — dummy values with the SHAPE of the real .env, so the gate
#    runs green with zero real secrets. Omit for engine-only projects.
# 5. validation.md — behavioral probes. No chat/UI surface? Say "None." and
#    say why the deterministic gate suffices.

# 6. Prove it — the conformance suite iterates EVERY profile on disk.
pnpm test

# 7. Confirm the cage picks up this project's Critical Files.
node scripts/cage-settings.mjs print /tmp/wt --project <id>
```

If step 6 is red, the profile is wrong — **not** the engine. If you find yourself
wanting to edit `scripts/` to onboard, you have found a profile field that does not
exist yet; add the field, don't hardcode the fact.

## Where things live
- `projects/<id>/` — the **project profile** (the only place a product fact may live).
- `missions/<project>/<slug>/` — `brief.md`, `plan.md`, `contract.md`,
  `features/NN.md`, `features/NN.handoff.md`. The whole mission is on disk —
  **safe to pick up cold** in a later window.
- Worker code — isolated in `.claude/worktrees/<slug>/` on branch `agent/<slug>`.
- `factory/decisions.md` — append-only log (the ADR replacement).
- `factory/constitution.md` + `AGENTS.md` — the rules every seat obeys.

## The PR record (opt-in)
Each mission can project itself onto a PR on the **product** repo carrying the
full validate→fix timeline: the first verdict (PASS *or* FAIL) opens a draft PR,
every round is posted as a comment, and `mission:ratify` marks it ready — the
local merge + `git push origin main` then flips it to Merged on its own. Disk
stays canonical; GitHub is a projection, exactly like the board. Every `gh` call
soft-fails, so an offline machine never blocks a verdict.

It is **off unless `FACTORY_PR=1`**, because `open` runs
`git push -u origin agent/<slug>`, which publishes every commit reachable from
that branch. Arm it only when the product repo's `main` is already pushed —
otherwise the PR drags along unpushed trunk commits:

```bash
# check first: 0 means the trunk is published and it is safe to arm
git -C ../../products/wahub rev-list --count origin/main..main
# then, per mission
FACTORY_PR=1 pnpm mission:ratify <slug> --project wahub
```

A mission whose PR never opened (projection off, or `gh` down) ships anyway;
`missions/<project>/<slug>/.pr.log` says why. Reconciliation is manual and
optional.

## The board
`pnpm board` (terminal: `backlog board`) is a ONE-WAY projection of
`missions/wahub/*` — a read-model, never a source of truth. Columns: Intake ·
Planning · Building · Validating · Needs Human · Done · Blocked. The three human
pulls (`gate:approve-plan` / `gate:ratify` / `gate:escalated`) surface as
`Needs Human` cards. `pnpm board:sync` repairs any drift. A PASS verdict never
auto-completes — `Done` only via `pnpm mission:ratify <slug>` after the merge.
Removing `backlog/` leaves the factory intact; the Intake column is canonical
for what-to-build-next.

### The dashboard
The published board at `https://factory.example.com/` is a **read-only
projection** of `missions/wahub/*` + the PRD — if it's wrong, fix the disk
(the brief, the PRD row, the verdict log), not the page. The
requirement↔mission join comes from each brief's `**Requirements:**` line.

**Auto-publish is automatic and idempotent.** Four bindings fire
`scripts/board-autopublish.mjs` detached (fire-and-forget — never blocks
its caller, always exits 0): `.husky/post-commit` + `.husky/post-merge` after
every commit/merge, and `verdict.mjs` + `ratify.mjs` after they record state and
auto-commit the dossier. The funnel renders every project dashboard + the root
index + the `/scrumban/` redirect, then content-hashes them (volatile timestamp
lines stripped) and rsyncs to the VPS **only when the hash changed**. The hash
memo lives at `dist/factory-board/.hash` (gitignored — losing it causes one
harmless republish). Unchanged → logs `sem mudanças`, no rsync, no history
append. Double-fires (verdict auto-commit → post-commit) are absorbed by the
hash guard; the funnel makes no commits itself, so it can never re-fire a hook.
`--dry-run` renders + hashes + prints the rsync target but never writes the
memo, never touches the network — safe to run repeatedly.

**Tests stay quiet.** `pnpm test:factory` exports `FACTORY_AUTOPUBLISH=0`; both
recorders' `triggerAutopublish()` return early under that flag, so
test-spawned verdicts/ratifications never publish the real board or pollute
`history.jsonl`.

**Debugging.** Every run appends one line to `factory/.publish.log` (gitignored,
append-only): `[<iso>] <publicado (hash …) | sem mudanças | erro …>`. If the
board looks stale or a publish silently failed, read it first.

**Per-project layout.** The manifest is `deploy/projects.json`:
```json
[{ "id": "wahub", "name": "Nexus CRM / WaHub", "repo": ".", "prd": "docs/prd/nexus-build-backlog.md" }]
```
Each entry renders to `dist/factory-board/<id>/index.html`; the root
`dist/factory-board/index.html` is one card per project. URLs: `/` root index ·
`/wahub/` dashboard · `/scrumban/` meta-refresh redirect to `/wahub/` (legacy).
To add a project: append an entry (`repo` is relative to the repo root) and
commit — the funnel renders it next run. VPS-side details (nginx, Traefik,
basic-auth users, rsync target) live in `deploy/DEPLOY-VPS.md`.

**Histórico tab.** The dashboard's third tab shows lagging indicators — missões
concluídas/semana, lead time mediano, rondas média, tokens, atenção-por-feature
— aggregated from `history.jsonl`. One snapshot row per mission is
appended on each publish that changed the hash
(`{ts, project, slug, state, features, rounds, verdict, reqIds}`). Missing data
renders "sem dados", never crashes. History content is stripped from the hash so
appending snapshots never triggers a republish loop.

**Manual fallback** (the bindings make this rare):
```bash
node scripts/board-autopublish.mjs --dry-run   # offline: render + print rsync target
node scripts/board-autopublish.mjs             # real publish (render + hash-guard + rsync)
pnpm board:report     # low-level: render only the wahub dashboard HTML
pnpm board:publish    # low-level: rsync only (bypasses the hash guard)
```

## Running many in a window
- Independent features within a mission can run in parallel; dependent ones
  serialize. Independent **missions** run in parallel via separate dispatch
  worktrees (`pnpm dispatch <slug>` already gives unique ports + DB).
- Queue several intents: plan them all, approve the ones you like, let build +
  validate run, then ratify the green ones in a batch.

## Safety rails (already true — the factory just obeys them)
- **Local-first:** nothing goes upstream until validated green locally and you
  ratify. Tenant A is in coexistence — real users — so this is non-negotiable.
- **Branches + tags** on `main` are the rollback. Never force-push the Lovable
  repo; keep its build green (the validator checks).
- Critical files (`bot/**`, `lib/waba.ts`, `prisma/schema.prisma`, …) are never
  edited unless a plan explicitly names them.

## The seats (default: Claude Code / claude -p)
- **Orchestrator** = an interactive Claude Code session (you + me). Reads the PRD.
- **Worker** = `claude -p` / dispatch, Sonnet seat. Clean context, one feature.
- **Validator** = fresh `claude -p`. Never saw the code.

### External agent seat (optional — save Anthropic tokens)
A worker or validator MAY run on an **external agent** via opencode (e.g. GLM 5.2
on a z.ai subscription plan) instead of a Claude seat:
```bash
pnpm factory:opencode --dir .claude/worktrees/<slug> --model zai-coding-plan/glm-5.2 \
  --slug <slug> --metric-seat worker|validator --prompt "<the seat's instruction>"
```
It is **still governed by the harness**: `opencode-worker.mjs` confines the agent
to a dispatched worktree (refuses any other `--dir` without `--allow-any-dir`),
logs its tokens/cost to `metrics.jsonl`, and — crucially — its output only counts
once the same deterministic gate + `verdict.mjs` schema pass, which the
orchestrator re-runs itself. Opt-in; the default Claude seats are unchanged. Full
recipes in the `mission-build` / `mission-validate` skills.

## Measure it
After a few missions, compare your **attention-minutes** (intent + approve +
ratify) against the old dispatch+review+probe flow. If it doesn't drop, we fix the
machine — or fall back to plain dispatch. The factory exists to buy back your hours.

## Read the meter
Every seat emits structured events (touchpoint, intervention, escalation,
false_idle, worker_death, phase_start/end) to `missions/wahub/<slug>/metrics.jsonl`
via `scripts/metrics.mjs`. After each mission:
```bash
node scripts/metrics.mjs summary <slug>
```
This prints event counts by type and the **attention-per-feature** figure
(touchpoints + interventions + escalations) — the KPI the whole factory optimizes
for (v2 §3.4). The §6 graduation rule ("kill the factory if attention-per-feature
doesn't fall") consumes this number; without it the rule is unmeasurable.
