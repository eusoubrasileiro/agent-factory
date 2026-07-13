# AmiticIA Factory — Constitution

> The standing rules every seat obeys. Terse on purpose. This is **broadcast** to
> the orchestrator, every worker, and every validator. It almost never changes;
> when a real decision is made, one line is appended to
> [`decisions.md`](./decisions.md) — never a new file.
>
> Engineering standards (runtime, test rules, coverage, commands) live in the
> repo root [`CLAUDE.md`](../CLAUDE.md) and each project's profile
> (`projects/<project>/`). "How we build here" lives in the `mission-*` skills, not
> a separate `AGENTS.md`. This file is the **factory operating contract** on top of them.

## The three seats

| Seat | Who runs it | Reads | Produces |
|---|---|---|---|
| **Orchestrator** | Andre + interactive Claude Code (`/mission-plan`) | the profile's PRD (`project.json → prd`), CLAUDE.md, the codebase | `brief.md`, `plan.md`, `contract.md`, scoped `features/NN.md` |
| **Worker** | `/mission-build` → dispatch worktree (caged `claude -p`, Sonnet default — any model works) | **ONLY** its one `features/NN.md` + this constitution | code + commit + `features/NN.handoff.md` |
| **Validator** | `/mission-validate` → fresh `claude -p`, **never saw the code** | **ONLY** `contract.md` + the mission git diff | a PASS/FAIL verdict with reasons |

## Reasoning-effort tiering by seat (v2 §3.5)

| Seat | Reasoning effort |
|---|---|
| Orchestrator (plan) | high / xhigh |
| Worker (build) | standard |
| Validator | high |

Reliability comes from reasoning budget and deterministic gates — do NOT add
checker tools expecting reliability (v2 §3.5: effort High→xHigh took
first-try-perfect 28%→89%; an added testing tool cost +42-68% for zero gain).

## The non-negotiables

1. **One human gate.** Andre authors the *intent* and approves the *plan + contract*. That approval is the gate. After it, the machine runs unattended until it has a verdict. Andre ratifies the final diff before anything goes upstream.
2. **The worker never authors its own contract.** "Done" is defined by the orchestrator/validator *before* code exists. Validation uses assertions the worker never sees pass. (80% of agent-authored tests are hollow — we do not let that in.)
3. **Validators are adversarial.** Fresh context, never read the worker's code or reasoning. They only have the contract and the diff. Tests written *after* code confirm decisions; they don't catch bugs.
4. **The PRD is orchestrator-only.** Workers and validators must **never** read the PRD or sibling feature specs — only their scoped slice. Whole-vision context biases the worker into scope-creep and rots its context. The orchestrator distils the PRD *down* into the feature spec.
5. **Clean context per worker.** Each worker reads only its `features/NN.md` (self-contained, ≤~1300 tokens, scoped file list, its own assertions, **no cross-references to siblings**) + this constitution. It does not free-roam `docs/`, does not read the PRD, does not read other features.
6. **Local-first containment.** Every mission is proven **green against LOCAL** (supabase local + `quality-gate` + the test suite + behavioral probes) on its own branch **before** anything is pushed upstream. Tenant A is in coexistence — real users exist. Prod is never touched without Andre's ratification. Branches + tags on `main` are the rollback.
7. **Serial on dependency, parallel only when independent.** Workers run one-at-a-time when features depend on each other (each inherits a green tree); genuinely independent features and all read-only ops may parallelize. Inter-mission isolation = `pnpm dispatch` worktrees.
8. **The deterministic gate is the wall.** `quality-gate` (+ the contract's held-out assertions) exits non-zero on any breach. No agent talks past a non-zero exit. The soft LLM review is a second opinion *inside* the gate, never a replacement for it.

## Doc altitudes (where truth lives)

| Altitude | Question | File | Precision |
|---|---|---|---|
| **Product** | how the product works / what it does | the profile's `prd` (`projects/<project>/project.json → prd`) | loose, careful — behavior not implementation |
| **Glossary** | what our words mean | per-project `CONTEXT.md` (optional; absent for the engine) | precise terms only |
| **Decisions** | why we picked X over Y | [`decisions.md`](./decisions.md) | one append-only line each |
| **Contract** | how we prove a feature is done | `missions/<project>/<slug>/contract.md` | maximally precise — testable assertions |
| **Worker knowledge** | how we build here | the `mission-*` skills + this constitution | imperative playbooks |

> **Archived:** the old `docs/adr/` forest is retired to `docs/_archive/` — it
> mixed altitudes and deceived agents (e.g. describing the OFF triage bot as the
> live product). It is **not ground truth**; do not read it. Restore from git if a
> specific rationale is ever needed.

## Provider-agnostic invariant

Every artifact here is a plain file or markdown skill (the `mission-*` skills,
specs, this constitution, the gate script, git, Postgres). Anything Claude-specific in the
**hard layer** (the gate, the event store) is a defect. Seats are config: today
all three are Claude Code / `claude -p`; a seat can later be re-pointed to
opencode / `agy` / a different provider with no change to the artifacts.
