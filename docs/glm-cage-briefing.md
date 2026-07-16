# Architect Briefing — Caging the Factory's External Agent Seat (`glm-cage`)

> **⚠️ SUPERSEDED (2026-07-15) — historical problem-statement, NOT current guidance.**
> The cage this briefing scopes has since been **built and shipped**. The architecture it
> deliberately left open was decided:
> - **The default external seat is Claude Code pointed at z.ai**, driven by
>   **`scripts/claude-worker.mjs`** — this is what a GLM 5.2 worker runs on today, and it
>   carries the Critical-File deny cage (the one boundary we have actually proven).
> - **`scripts/opencode-worker.mjs` is the FALLBACK only** — for providers with no
>   Anthropic-compatible endpoint. It is NOT the driver; do not reach for it by default.
> - **To dispatch a worker, follow the shipped procedure, not this doc:** the `mission-build`
>   skill (`skills/mission-build/SKILL.md`) and RUNBOOK § "The external seat and its cage".
>   The implemented result and its empirical cage checks live in
>   [`cage-research-2026-07-09.md`](cage-research-2026-07-09.md).
>
> This file is retained **only** as the historical threat-model / building-block survey that
> informed that design. Everything below §0 was written before the decision and reflects the
> reality of 2026-07-08 (opencode as the then-driver) — read it as history, act on the RUNBOOK.

> **Status (original, 2026-07-08):** exploration + data-gathering only. This document exists so an architect can
> write the real implementation plan. It states the problem, the current reality, the
> threat model, and the building blocks with their trade-offs. It deliberately does **not**
> pick an architecture — that is the architect's job. Compiled 2026-07-08 from three
> read-only scouts + two live web/doc sweeps + a KB research pass (all sources cited inline).

---

## 0. Why this exists (the prompt behind it)

The factory runs feature code through a **third-party model** (GLM 5.2, via z.ai's subscription
plan) to keep Anthropic spend at $0. That model's CLI (`opencode`) runs on Andre's machine with
**the operator's full privileges and full secret set**. Andre asked, in his words: *"should we use
a custom cage for [the GLM agents]… like Akita's coding-bot jail?"*

The honest answer from the recon is **yes — the current containment is a convention, not a
boundary.** This briefing gives the architect everything needed to design that cage.

Two independent failure modes have already been observed and motivate this:
1. **Scope violation** — a prior mission's worker (W1) silently edited `backend/src/bot/**` (a
   Critical File) and smuggled it into a commit; caught only by post-hoc human review.
2. **Timeout data-loss** — the driver's hard 30-min `SIGKILL` killed a worker mid-handoff (work
   survived only because it had already committed). Fixed tactically (pass `--timeout`), but it
   exposed that the driver has no resume/heartbeat despite `opencode` supporting `--session`.

---

## 1. Current state — what exists to modify

### 1a. The driver: `scripts/factory/opencode-worker.mjs` (297 lines)
- Spawns `spawn("opencode", ["run","-m",model,"--dir",dir,"--format","json", …])`.
- **No `cwd` set, no `env` set** on the spawn → the child **inherits the operator's entire
  `process.env`**, every secret included. No filtering, no allowlist.
- Confinement = one line: `isWorktreeDir(dir)` is a **pure substring test** — `dir.includes("/.claude/worktrees/")`. Env-overridable (`FACTORY_WORKTREE_MARKER`) and fully bypassable (`--allow-any-dir`). It governs *where a git write is expected to land*, **not what the process can read or reach.**
- Timeout: hardcoded `DEFAULT_TIMEOUT_MS = 30*60*1000`, `child.kill("SIGKILL")` — no SIGTERM grace, no env override (only the `--timeout` flag).
- Resume: the flags `--session <id>` / `--continue` exist and pass through to opencode, and the sessionID is surfaced in `--json-out`, but **nothing auto-persists or auto-resumes** — the orchestrator must wire it by hand (which we now do).
- Completion = `exitCode===0 && sawFinish` (a `step_finish` event in the stream). No idle/heartbeat detection.

### 1b. Dispatch: `scripts/dispatch-worktree.sh` (321 lines)
- Provisions: git worktree on `agent/<slug>`, 4 hashed ports, a per-slug Postgres DB `wahub_<slug>` on the **shared** local server (`127.0.0.1:5437`, same `wahub:wahub` role), a `.agent-env` override.
- **Secrets: `.env`, `.env.test`, `.env.smoke` are SYMLINKED to the parent** (`ln -sfn "$PARENT_ROOT/$f" …`, line 199). So worktree "isolation" does **not** isolate secrets — every dispatched worktree reads the operator's real prod/live secret files.
- **OS-level isolation: NONE.** Grep for `unshare|bwrap|firejail|docker|chroot|cgroup|seccomp|apparmor` across both files → zero hits. Same uid, same network namespace, same filesystem root as the operator.

### 1c. The pattern doc's promise vs reality
`standards/agent-patterns/factory-templates/external-agent-seat.md` claims only two containment
guarantees: *"it can never mutate the main tree"* (rests entirely on the substring path check) and
*"gate-governed"* (output isn't trusted until the deterministic gate + held-out validator pass). It
makes **no claim** about filesystem/network/secret isolation. So the cage work does not contradict
the doc — it hardens a boundary the doc never asserted.

### 1d. Secrets actually exposed today (key names only — from the symlinked root `.env`)
Two **critical** (highest blast radius): `SUPABASE_SERVICE_ROLE_KEY` (full DB, bypasses RLS),
`WABA_TOKEN_KEY` (AES key that decrypts stored WhatsApp access tokens). Plus **high**: `JWT_SECRET`,
`FACEBOOK_APP_SECRET`, `WABA_WEBHOOK_SECRET`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`,
`RESEND_API_KEY`, `DATABASE_URL/DIRECT_URL`, `POSTGRES_PASSWORD`. A third-party model's CLI can read
all of these today.

### 1e. **Key enabling fact — the gate does NOT need prod secrets.**
`backend/test/setup/env.ts` injects deterministic **dummy** values for every secret the schema
requires (`WABA_TOKEN_KEY` = fixed test hex, Supabase keys = "…-placeholder", `JWT_SECRET` = test
string), and Prisma/WABA/Supabase are **mocked** in unit tests. Eval tests are gate-excluded and
self-skip without a provider key. → **`pnpm test:factory` + `tsc` + `lint` + `quality-gate` +
backend/frontend unit tests + hermetic `test:e2e` all run green on a minimal/dummy `.env`.** Real
secrets are only needed for opt-in `test:vendor-smoke` and, situationally, the `test:e2e:real`
frontend/BFF path — neither of which a feature-worker needs. This is what makes secret-minimization
cheap and safe.

### 1f. Critical Files the cage must protect (per-path deny targets)
`backend/src/bot/**`, `backend/src/logger.ts`, `backend/src/middleware/audit-log.ts`,
`backend/src/lib/waba.ts`, `backend/test/e2e/real/**`, `backend/test/eval/**`,
`frontend/tests/e2e/**`, `frontend/tests/e2e-real/**`, `.husky/**`, `commitlint.config.cjs`,
`quality-baseline.json`, `.claude/settings.json`, `prisma/schema.prisma`.

---

## 2. Threat model — what the cage is actually defending against

Rank-ordered by likelihood × blast radius, from the observed reality (not hypotheticals):

| # | Threat | Today's exposure | What stops it |
|---|--------|------------------|---------------|
| T1 | **Worker edits a Critical File** (scope violation, seen in W1) | post-hoc review only | **per-path deny rules at tool-call time** (harness layer) |
| T2 | **Third-party model's CLI reads prod secrets** (`.env` symlinked, full env inherited) | nothing | **secret minimization** (minimal-env worktree) + **filesystem cage** (hide `.env`) |
| T3 | **Compromised dependency exfiltrates** (supply-chain — Akita's stated motivation) | nothing | **network egress control** (the hard part — see §4) |
| T4 | **Worker writes outside the worktree** (home, sibling repos, system) | substring path check only | **OS filesystem jail** (bind-mount worktree only) |
| T5 | **Timeout kills in-flight work / silent black box** | tactical `--timeout` fix | **driver:** heartbeat + auto-resume + run archive |

Note T1 is a *harness-permission* problem (a Docker jail cannot stop an in-worktree edit to a
tracked file); T2/T4 are *filesystem/secret* problems; T3 is a *network* problem that, per the data
below, **no single tool fully solves** on our platform. The architect should treat these as separable
layers, not one monolith.

---

## 3. Building block A — Claude Code as the caged seat (replace/augment opencode)

z.ai **officially supports** pointing Claude Code at their Anthropic-compatible endpoint, so CC can
run GLM 5.2 as the worker while giving us CC's native permission system — the thing opencode lacks.

### 3a. z.ai endpoint config (official, from docs.z.ai/devpack/tool/claude)
```jsonc
// settings env block
"ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
"ANTHROPIC_AUTH_TOKEN": "<z.ai API key>",     // machine-local secret, NEVER committed
"ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2",
"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000",
"API_TIMEOUT_MS": "3000000"
```
- **Model string conflict to resolve:** z.ai docs say `glm-5.2`; multiple community guides insist on
  `glm-5.2[1m]` to unlock the real 1M context. **UNVERIFIED** — the architect must test a long
  session and watch the context meter. (`CLAUDE_CODE_AUTO_COMPACT_WINDOW: 1000000` sets the compaction
  target either way.)
- Flat-rate subscription (our "$0 marginal"), but **capped, no overage** — hit the cap → stops until
  the window resets. Tiers: Lite $18 / Pro $72 / Max $160 per month. GLM-5.2 burns quota at 3× peak /
  2× off-peak. The architect should size the tier against expected mission volume.

### 3b. CC headless (the driver surface — replaces opencode's stream parsing)
- `claude -p "<prompt>" --output-format stream-json --verbose` → newline-delimited events =
  **native heartbeat** (kills T5's black box). `--output-format json` gives `{result, session_id,
  usage, total_cost_usd}`.
- Resume: `--resume <session_id>` headlessly continues; sessions persist at
  `~/.claude/projects/<proj>/<id>.jsonl`, survive crash. (**auto-resume** on wall-clock cap = a driver
  loop we write.)
- **No documented hard wall-clock limit** on `-p` runs (opencode's SIGKILL was self-imposed).

### 3c. CC permission system (this is the cage core for T1)
- `permissions.deny` supports **path globs**: `Edit(backend/src/bot/**)`, `Write(/home/**)`,
  `Read(.env)`. Deny is checked **before** the tool runs and **wins over any allow at any level**
  (deny-first). This is exactly the per-path Critical-Files guard T1 needs, enforced at tool-call
  time instead of post-hoc.
- Path anchoring is subtle: single `/` is **settings-file-relative or home-relative, NOT filesystem
  absolute**; `//tmp` = real root. The architect must get anchors right or rules silently miss.
- `--permission-mode dontAsk` = pre-approved tools only, everything else denied (fail-closed) —
  the correct headless posture. `--settings <file>` points at a per-seat settings file; deny rules
  there cannot be overridden by lower layers.
- **Caveat:** deny rules on `Read/Edit/Write` govern **CC's own tools** and the shell commands CC
  recognizes (`cat`, `sed`, …). They do **not** stop an arbitrary subprocess (a `node`/`python`
  script the agent writes) from opening a denied file itself. So permission rules harden T1 but are
  **not** a substitute for the filesystem jail (T2/T4).

### 3d. CC's own sandbox (partial T2/T3/T4 on Linux)
CC ships a Linux sandbox (needs `bubblewrap` + `socat`) configurable via `settings.sandbox`:
`filesystem.allowWrite/denyRead`, `network.allowedDomains` (**real per-domain egress allowlist** —
this is stronger than ai-jail on network, see §4), and `credentials` to `deny`/`mask` env vars per
host. **UNVERIFIED:** interaction between CC's own bubblewrap sandbox and an outer ai-jail bwrap
(nested bwrap "considerably weakens security" per Akita) — the architect must decide **one** jail
layer, not both.

### 3e. Tool-use fidelity risk (the reason to A/B, not to switch blind)
GLM 5.2 does function-calling but "behavior can differ slightly from Claude's native
implementation," and quality "degrades on compounding-autonomy tasks" vs short loops. No published
tool-use benchmark. → **Treat CC-on-GLM as a compatibility test:** the architect should require an
A/B (same feature spec through opencode-seat vs CC-cage-seat) measuring gate pass, wall time, tokens,
and violation count before making CC-cage the default. Keep the opencode driver in-tree as a fallback
seat regardless.

---

## 4. Building block B — Akita's `ai-jail` (the OS filesystem jail, T4/T2)

**It's real, maintained (v1.4.0), Rust, and targets our exact agents** (`ai-jail claude`,
`ai-jail codex`, `ai-jail opencode`). Sources: akitaonrails.com 2026-03-01 + github.com/akitaonrails/ai-jail.

### What it does well (T4 + T2 — filesystem blast-radius)
- Wraps **Bubblewrap + Landlock** (Linux). `$HOME` → **ephemeral tmpfs** (empty, wiped on exit); **only the
  current project dir is writable + persistent**; `.aws/.ssh/.gnupg` never mounted unless opted in;
  system paths read-only. `--mask <path>` hides a file (e.g. `.env`), `--deny-path` denies it.
- Config via committable `.ai-jail` TOML (`mask=[".env","**/*.env"]`, `deny_paths=[…]`,
  `rw_maps=[…]`). Install: `sudo apt install bubblewrap` then `cargo install ai-jail` / brew / mise.
- No root at runtime (unprivileged user namespaces). Established-library-first: this is a real tool,
  not a hand-rolled script — aligns with the "prefer established libraries" rule.

### Two hard caveats the architect MUST weigh
1. **Ubuntu 24.04 blocker (our machine):** Ubuntu 24.04+ enforces **AppArmor restrictions that block
   the unprivileged user namespaces `bwrap` needs.** ai-jail does **not** work out-of-the-box on
   z390m — requires a one-time AppArmor profile or sysctl relaxation. (Same prerequisite CC's own
   Linux sandbox has — they share the bwrap dependency.)
2. **Network is NOT domain-scoped.** Default = **full host network (unrestricted egress)**. The only
   control is `--lockdown` (cut all net) + `--allow-tcp-port 443` (re-open a **port**, to *anywhere*).
   It **cannot** allowlist `api.z.ai` specifically. So ai-jail does **not** solve T3 (exfiltration) —
   Akita says so himself: *"these are process sandboxes, not hardware isolation… treat ai-jail as one
   layer, not the whole boundary."* For true per-domain egress, **CC's own `sandbox.network.
   allowedDomains` is the stronger primitive** (§3d) — which argues for CC's sandbox over ai-jail on
   the network axis, or accepting that T3 is out of scope for v1.

---

## 5. Building block C — secret minimization (cheapest, biggest T2 win)

Independent of A and B, and enabled by §1e: **stop symlinking the real `.env` into external-seat
worktrees.** Dispatch gains a `--seat external` mode that writes a **minimal `.env`** (per-agent test
DB URL + the dummy values the schema needs, no prod WABA/Supabase/LLM keys). The gate stays green
(proven — §1e). This closes the two `critical` exposures (`SUPABASE_SERVICE_ROLE_KEY`, `WABA_TOKEN_KEY`)
with a ~20-line dispatch change and **no jail at all**. The architect should consider shipping this
first — it's the highest risk-reduction-per-effort item on the board.

⚠️ **`dispatch-worktree.sh` is a secrets-handling file** — its diff needs Andre-visible review.

---

## 6. The option space (for the architect to choose among — NOT a decision here)

The three blocks are **composable layers**, and the data suggests they map cleanly onto the threat
tiers. Rough menu, cheapest→strongest:

- **Layer 1 (secret-min, block C):** kills T2's critical exposures. ~1 dispatch change. No new deps.
- **Layer 2 (CC-cage, block A):** kills T1 (per-path deny at tool-call time), adds heartbeat +
  resume (T5), and via CC's own sandbox gives *optional* per-domain egress (partial T3) + fs cage
  (T4). Bigger lift: a new `claude-worker.mjs` driver + per-seat settings template + the z.ai wiring
  + the A/B validation.
- **Layer 3 (ai-jail, block B):** strongest fs blast-radius (T4/T2) but needs the Ubuntu-24.04
  AppArmor fix and does **not** do domain egress. Overlaps CC's own sandbox — likely **either** CC-
  sandbox **or** ai-jail, not both (nested bwrap is discouraged).

Observations the data supports (the architect may weigh differently):
- Layers 1 and 2 are **not** mutually exclusive and address different threats; 3 partly overlaps 2.
- The single biggest risk-reduction-per-effort is **Layer 1**.
- The observed, repeated failure (T1 scope violation) is **only** solved by Layer 2's per-path deny
  rules — no OS jail addresses it.
- No option on our platform cleanly solves **T3** (exfiltration) today; CC's `allowedDomains` is the
  closest, ai-jail explicitly punts. The architect should decide whether T3 is in-scope for v1 or
  deferred with eyes open.

---

## 7. Open questions the architect must resolve

1. **Seat strategy:** CC-cage as the *default* worker, or keep opencode default and add CC-cage as an
   opt-in hardened seat? (Depends on the A/B result — GLM-in-CC tool-use fidelity is unproven.)
2. **Jail layer:** CC's own `sandbox` (bubblewrap, domain egress, integrated) **vs** ai-jail (separate
   tool, stronger fs defaults, port-only egress)? Not both. Both need the Ubuntu-24.04 AppArmor fix —
   is Andre willing to make that one-time system change? (It slightly widens the host's unprivileged-
   userns surface.)
3. **T3 scope:** is exfiltration defense (per-domain egress) in v1, or explicitly deferred?
4. **Model string:** `glm-5.2` vs `glm-5.2[1m]` — settle empirically before building on it.
5. **Subscription tier** for the z.ai plan vs expected mission volume (cap, no overage).
6. **Driver consolidation:** one driver with a `--engine opencode|claude` switch, or two sibling
   drivers? (Run archive / heartbeat / auto-resume / `--gate` improvements should land once, in
   whichever shape wins.)
7. **Settings provenance:** the per-seat `.claude/settings.json` (deny rules) is itself a Critical
   File — how is it generated at dispatch and protected from the very agent it constrains? (Deny
   `Edit(.claude/**)` inside the worktree; write it from dispatch, not the agent.)

---

## 8. Constraints & standing rules the plan must honor

- **Established-library-first:** prefer ai-jail / CC's built-in sandbox over hand-rolled bwrap. (KB +
  workspace rule.)
- **Anti-Vibe/TDD:** cage code is factory tooling → same gate (`test:factory`, tsc, lint, quality-gate);
  built by GLM workers in a mission, held-out validator, human ratify.
- **Secrets never committed:** z.ai token + any htpasswd stay machine-local; `dispatch` secret-min diff
  is Andre-reviewed.
- **Adversarial acceptance probe (required):** a mission contract assertion must *plant* a "edit
  `backend/src/bot/x`" instruction in a worker prompt and prove the cage **blocks** it — behavior, not
  intent.
- **Solo-operator scope:** no multi-tenant/hardware-isolation gold-plating; process sandbox + secret-min
  is proportionate to a single-owner factory. (Akita's own "not 100% secure, but enough" framing.)

---

## 9. Sources (all fetched/verified 2026-07-08)
- KB research pass (confidence high): Akita "ai-jail" 2026-03-01; Simon Willison "A field guide to
  sandboxes" 2026-01-06; Anthropic "Claude Code sandboxing" 2025-10-20 + "Effective harnesses for
  long-running agents" 2025-11-26; HN 44653950 "They also support Claude Code" 2026-03-27.
- Claude Code docs: code.claude.com/docs (headless, sessions, permissions, hooks, sandbox, third-party endpoints).
- z.ai: docs.z.ai/devpack/tool/claude, z.ai/subscribe, docs.z.ai/devpack/faq.
- ai-jail: akitaonrails.com/en/2026/03/01/…, github.com/akitaonrails/ai-jail (README + docs/sandbox-alternatives.md).
- Repo recon: `scripts/factory/opencode-worker.mjs`, `scripts/dispatch-worktree.sh`,
  `standards/agent-patterns/factory-templates/external-agent-seat.md`, `backend/test/setup/env.ts`,
  `backend/vitest.config.ts`, `products/wahub/CLAUDE.md`.

**Unverified flags carried forward:** model-string suffix (§3a/§7.4); CC-sandbox × ai-jail nesting
(§3d/§7.2); GLM-5.2 real usable context in CC; exact z.ai cap vs our mission volume.
