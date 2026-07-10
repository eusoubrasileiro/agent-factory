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

## The external seat and its cage

The default external seat is **Claude Code pointed at z.ai** (`claude-worker.mjs`). Same
flat z.ai plan, zero Anthropic tokens, and its Critical-File deny is the one we have
actually proven (cage-research M1). `opencode-worker.mjs` is the fallback for providers
with no Anthropic-compatible endpoint.

```bash
node scripts/claude-worker.mjs --dir <worktree> --model glm-5.2 \
  --slug <slug> --project <id> --metric-seat worker --timeout 2700000 \
  --prompt "..."
```

Want a **Sonnet** worker instead? Same driver, same cage, one extra flag:
```bash
node scripts/claude-worker.mjs --dir <worktree> --model sonnet --project <id> --allow-anthropic --prompt "..."
```
It spends Anthropic tokens (or your plan quota) rather than the flat z.ai plan, which
is why the flag is mandatory rather than a default. Never combine `--model sonnet` with
a z.ai base URL: the alias resolves through `ANTHROPIC_DEFAULT_SONNET_MODEL`, which z.ai
tells you to point at `glm-5.2` — you would run GLM while believing you ran Sonnet.

It **refuses to spawn** in three cases, all silent and expensive if allowed:
- no `--project`, or one that names no known profile → the cage's Critical-File rules and the
  run's telemetry both come from the profile; a forgotten flag would render a cage with zero
  product Critical Files and say nothing. `--allow-uncaged` does NOT bypass this (D-24).
- no `ANTHROPIC_BASE_URL`, or one pointing at `anthropic.com` → it would quietly bill real
  money for a seat that must be flat-rate. Credentials live in `~/.config/amiticia/zai.env` (0600).
- the cage cannot be written or fails its own audit → `--allow-uncaged` is the explicit override.

Probe the cage:
```bash
node scripts/probe-cage.mjs <worktree> --project <id>                      # static, free
node scripts/probe-cage.mjs <worktree> --project <id> --live -m glm-5.2    # live, costs quota
```

**Read this before trusting it.** The static probe proves our renderer. Only `--live` proves
the driver honours the deny, and it asserts on file hashes and git refs — never on
`permission_denials`, which returns `[]` even when a deny fires. The live probe has not yet
run against either driver (D-17).

**The OS sandbox is OFF here, and that is a machine fact, not a choice.** Claude Code's
sandbox cannot initialise on this kernel (`write /proc/self/setgroups`), identically with
AppArmor's userns restriction on and off (D-18). `sandbox.enabled` is read from
`~/.config/amiticia/factory-machine.json`; absent → off. What the cage does give you is the
Edit/Write deny on Critical Files, which is a **real** boundary. What it does not give you:
an `Edit` deny does not stop `python3 -c "open('.env').read()"`. Secrets are contained by the
dummy `.env` in the worktree, not by a deny rule.

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

**Only the real factory publishes** (D-31). `board-publish.sh` rsyncs
`<repoRoot>/dist/factory-board/` with `--delete`, so whatever that directory
holds *becomes* the live board. `run()` therefore refuses the rsync unless
`path.resolve(repoRoot) === ROOT` **and** `FACTORY_AUTOPUBLISH !== "0"`; a fixture
root renders, keeps its own local memo, and logs `rsync ignorado: …`. This is the
guard that matters: `FACTORY_AUTOPUBLISH=0` alone protects nothing, because it
lives in `verdict.mjs`/`ratify.mjs` — the *callers*. Until 2026-07-09 every test
that ran the CLI with `--repo <tmp>` and no `--dry-run` published its own fixture
over production; the live board was found serving one requirement `A1` and one
mission `alpha`. Note `pnpm test` sets the flag but a raw `node --test` does not.

**A failed rsync never memoizes** (D-32). The rsync's exit status decides: on
failure the funnel logs `rsync falhou — nada publicado`, **preserves** the old
hash memo so the next run retries, and still exits 0. Writing the memo after a
failed publish would freeze the live board in silence — every later run reporting
`sem mudanças` while the VPS serves stale HTML.

**Debugging.** Every run appends one line to `factory/.publish.log` (gitignored,
append-only): `[<iso>] <publicado (hash …) | sem mudanças | rsync falhou … |
rsync ignorado: … | erro …>`. If the board looks stale, read it first — and
remember the log lives under the `repoRoot` that ran, so a fixture's lines never
land here.

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

**Intake tab.** A project whose profile declares `intake[]` gets a fourth tab: the
requirement as the client stated it, followed forward to its verdict.
```json
"intake": [{ "file": "../../../clients/tenant-a/requirements-intake.md",
             "prefix": "IN", "label": "Tenant A — WaHub / Nexus" }]
```
`file` is relative to the factory root, like `path`. The chain is
`IN-NN → backlog row → mission → verdict`: the row's `Porquê / fonte` column is
scanned for citations, including the compressed form the docs actually use
(`IN-33/35/38/40a` expands to four ids; a sub-part letter collapses onto its row).
An `IN` no row cites renders **"não despachado"**. No `intake[]` → no tab, so the
engine stays product-agnostic (D-15). **What is declared is published** — see
D-30 before adding a source; the CIPE and CIDS intakes are deliberately absent.

Edit it locally with `pnpm intake` (`scripts/intake-server.mjs`): binds `127.0.0.1`
only, reuses the board's own `renderIntakeTab`, and writes back to the `.md` after
a `.bak` copy. Writes stay local-first; the VPS never gets write access.

**Manual fallback** (the bindings make this rare):
```bash
node scripts/board-autopublish.mjs --dry-run   # offline: render + print rsync target
node scripts/board-autopublish.mjs             # real publish (render + hash-guard + rsync)
pnpm board:report     # low-level: render only the wahub dashboard HTML
pnpm board:publish    # low-level: rsync only (bypasses the hash guard)
pnpm intake           # local intake editor (loopback, writes the .md + .bak)
```

## Running many in a window
- Independent features within a mission can run in parallel; dependent ones
  serialize. Independent **missions** run in parallel via separate dispatch
  worktrees (`pnpm dispatch <slug>` already gives unique ports + DB).
- Queue several intents: plan them all, approve the ones you like, let build +
  validate run, then ratify the green ones in a batch.

### Vendor limits on the external seat (z.ai coding plan, glm-5.2)

- **Max concurrency: 10.** Do not run more than ten `glm-5.2` builder seats at once.
  Past that the provider rejects the extra sessions; the fan-out does not queue for you.
- **Usage is a 5-hour rolling window, not a credit balance.** When it is exhausted the
  API answers `429 rate_limit_error` (z.ai `code 1308`) with the exact reset timestamp —
  e.g. *"Usage limit reached for 5 hour. Your limit will reset at 2026-07-10 03:55:20"*.
  Your credit is fine; you are early.
- **The failure is silent in `opencode`.** It hangs with zero bytes on stdout AND stderr
  until the timeout kills it — a 30-minute no-op that looks like a slow build. `claude -p`
  only reveals it with `--print-logs`. If a builder produces nothing, check the limit
  before you debug anything else:

```bash
# Is z.ai answering? 200 = fine. 429 = rate-limited, and the body names the reset time.
set -a; . ~/.config/amiticia/zai.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$ANTHROPIC_BASE_URL/v1/messages" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  -d '{"model":"glm-5.2","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}'
```

Concurrency and the rolling window interact: ten seats burn the window five times faster
than two. Sizing a fan-out is a spend decision, not a throughput one.

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
