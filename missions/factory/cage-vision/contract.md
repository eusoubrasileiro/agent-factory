# Contract — cage-vision (F9)

**Project:** factory · **Seat:** COORDINATOR (not a caged GLM build) · **Blast radius:**
medium — this is cage-security tooling. Per `docs/glm-cage-briefing.md §7.7`, a caged agent
must **never author its own cage** ("write it from dispatch, not the agent"); `cage-settings.mjs`
and `claude-worker.mjs` are therefore Critical Files a GLM seat may not edit. F0 and F5 ran
coordinator-seat for the same reason. The GLM-on-Playwright run happens at **validation** time
(V3) — the first real end-to-end proof, orchestrated by the coordinator.

## Why (business)

The whole F-wave exists because the factory's validate loop was **blind to rendered UI**: the
held-out validator ran `pnpm test` (green) and never opened the board, so M4's tooltips /
staleness banner / lint chips slipped in as claimed-but-unshipped. F0 wrote the rendered-DOM
probe recipe into `projects/factory/validation.md` — but the recipe was **aspirational**: the
caged validator seat has **no Playwright MCP** (`claude-worker.mjs:361` passes `--settings` but
no `--mcp-config`, and the seat runs under a throwaway `CLAUDE_CONFIG_DIR` deliberately isolated
from the operator's `~/.claude.json` where Playwright lives). Confirmed across the whole factory:
no `validate.log` contains `browser_navigate`/`browser_snapshot`. The eyes were never wired.

F9 wires them — **on GLM-5.2**, honoring the z.ai plan's intent (validation costs $0 Anthropic),
**without** turning the seat into a data-exfiltration channel.

## The security decision (ratified 2026-07-14, André — risk owner)

Research + both Fable cage docs (`cage-research`, `glm-cage-briefing`) established: adding a
browser to a secret-bearing seat completes the **lethal trifecta** (reachable secrets + untrusted
actor + a way to send data out). The mitigation is to break the *data* leg, not to ban the
browser. Two facts make that cheap:

1. **The seat's env is already secret-free.** `buildSpawnEnv` (`opencode-worker.mjs:163`) scrubs
   the child env to a hard allowlist (`PATH,HOME,LANG,LC_ALL,TERM,TMPDIR,XDG_*`) + the z.ai creds
   only; `buildClaudeEnv` additionally deletes every `CLAUDE_ENV_KEY` from the coordinator env.
   `SUPABASE_SERVICE_ROLE_KEY`, `WABA_TOKEN_KEY`, LLM keys — all dropped before the seat starts.
   A browser here cannot read customer keys *from its environment*.
2. **Env is the crown-jewel leg; the residual is filesystem-absolute-path reads.** A seat running
   as the operator uid can `python3 -c "open('/…/products/wahub/.env').read()"` (T2 / M2/M3). On
   this machine the one primitive that would close that kernel-hard — CC's filesystem sandbox —
   **cannot initialize** (D-18/M9). Closing it absolutely needs a dedicated unix user or ai-jail
   (unproven on z390m).

**Ratified threat tier: A (proportionate).** The operating adversary is *careless* GLM, not
malware (`cage-research §6 Q1`); the crown-jewel env leg is already closed; a bounded
"drive the board and assert tiles" task will not wander into a product `.env`. F9 therefore:
env-scrub (already true) + keep the deny rules biting on the tool/recognized-bash secret path +
**plant-and-prove** the canary read fails on that path — and **documents the python-bypass
residual openly** as accepted under the careless-model model. Tier B (kernel-hard, dedicated
user / ai-jail) is a noted follow-up if the threat model ever shifts to malicious.

## Scope

`scripts/claude-worker.mjs` (+ `.test.mjs`), `scripts/cage-settings.mjs` (+ `.test.mjs`),
`projects/factory/validation.md`. Do NOT touch board-report.mjs, history.mjs, or any product.

## Requirements (EARS)

**R1 — a `--with-playwright` seat loads exactly one MCP server: Playwright.**
WHEN `claude-worker.mjs` is invoked with `--with-playwright`, it SHALL write a
Playwright-only MCP config to `<worktree>/.claude/mcp-playwright.json` declaring exactly one
stdio server named `playwright` (`npx @playwright/mcp@latest --isolated`, empty `env`) and no
others, and the spawned `claude` args SHALL include `--mcp-config <that path>` **and**
`--strict-mcp-config` (so the operator's other MCP servers — whatsapp, supabase, etc. — are
never loaded). WHEN the flag is absent, no MCP config file is written and neither flag is added
(current behavior byte-for-byte unchanged). `--isolated` is mandatory: the shared Playwright
Chrome profile is single-instance (`[[playwright-mcp-single-instance]]`); an ephemeral isolated
profile avoids the SingletonLock collision with the operator's own driver.

**R2 — the visual-validator cage allows the browser + verdict, and nothing more.**
`cage-settings.mjs` SHALL expose a way to render the cage for a visual-validator seat (e.g. a
`visualValidator: true` render option threaded from a `--with-playwright` spawn) whose
`permissions.allow` gains exactly `mcp__playwright` (all Playwright tools — the headless seat
must not hang on a permission prompt for `browser_navigate`/`browser_snapshot`) and
`Bash(node scripts/verdict.mjs)` + `Bash(node scripts/verdict.mjs *)`. It SHALL add **no**
git-write allow beyond the base (a validator records a verdict; it does not commit). Every base
deny (secret reads, `WebFetch`, `WebSearch`, `curl`/`wget`/`nc`/`scp`, `git push`, `sh`,
`bash -c`, the `.claude`/`.mcp.json`/`CLAUDE.md` self-edit denies) SHALL remain. The generated
`mcp-playwright.json` SHALL itself be deny-Edit/Write (same discipline as `.mcp.json`), so the
seat cannot rewrite its own MCP wiring.

**R3 — env carries no product secret (regression pin on the crown-jewel leg).**
GIVEN a source env containing `SUPABASE_SERVICE_ROLE_KEY`, `WABA_TOKEN_KEY`, `OPENROUTER_API_KEY`,
`DATABASE_URL`, `JWT_SECRET`, `buildClaudeEnv(sourceEnv, creds, dirAbs)` output SHALL contain
NONE of them, SHALL contain the z.ai `ANTHROPIC_*` creds, and SHALL set `CLAUDE_CONFIG_DIR` under
the worktree. This pins the property F9's safety rests on so a future allowlist edit can't silently
re-admit a secret.

**R4 — plant-and-prove: the deny path bites; the residual is documented.**
A test SHALL prove that the rendered visual-validator cage denies reading a canary secret on the
**tool / recognized-bash** path — i.e. the settings' `permissions.deny` contains an anchored
`Read(~/.config/amiticia/**)` (the z.ai creds dir, where a canary can be planted) and a Bash
guard covering `cat`/interpreter access to it, so a seat's `Read(...)` or `cat` of the canary is
blocked. The contract and `validation.md` SHALL state plainly that an arbitrary
`python3 -c "open(...).read()"` **bypasses** this (no OS sandbox on this machine, D-18/M9) and
that this residual is **accepted under the ratified Tier-A careless-model threat model**, not
hidden. (Behavioral proof of the deny biting from inside a live seat is part of V3.)

**R5 — rules.** No product literals anywhere in `scripts/**`
(`scripts/project-profile.test.mjs:370` stays green — the wahub paths in this contract's prose do
NOT enter `scripts/**`). No `Date.now()`/`Math.random()` in rendering paths. Tests are
`node:test` + `node:assert/strict` inside the `pnpm test` globs. Keep every script's `isMain`
guard, header comment, and soft-fail semantics. The `assertSeatEndpoint` / `assertNoAliasTrap` /
fresh-cage-per-spawn guards SHALL still fire on the `--with-playwright` path (no guard bypass).

**R6 — `validation.md` describes the now-REAL wired probe.**
The `Probe: board rendered-DOM (Playwright)` section SHALL be updated from aspirational to actual:
the exact spawn (`node scripts/claude-worker.mjs --dir <worktree> --model glm-5.2 --project
factory --metric-seat validator --with-playwright --prompt-file <probe>`), the note that
`--strict-mcp-config` limits the seat to Playwright only, the `--isolated` serialization note, and
the Tier-A residual disclosure. The recipe's coordinator-serves-on-127.0.0.1:8799 step stays.

## Verification (the gate is necessary, NOT sufficient)

**V1** `pnpm test` green from the factory repo root (worktree board-sync skips expected).

**V2 — unit (RED first):**
- `claude-worker.test.mjs`: with `--with-playwright`, the built claude args contain
  `--mcp-config` + `--strict-mcp-config`; the generated `mcp-playwright.json` parses to exactly
  one server `playwright` with `--isolated` and no second server; without the flag, neither
  appears and no file is written. `buildClaudeEnv` R3 secret-absence pin.
- `cage-settings.test.mjs`: the visual-validator render adds `mcp__playwright` +
  `Bash(node scripts/verdict.mjs*)` to `allow`, adds NO extra git-write, keeps all base denies,
  and deny-covers `mcp-playwright.json` Edit/Write; `auditCageSettings` returns clean (anchoring
  intact); R4 canary-deny assertion.

**V3 — first real GLM-5.2-drives-Playwright run (coordinator-orchestrated — the acceptance the
green tests are NOT).** Serve the factory board on `127.0.0.1:8799`; spawn a GLM-5.2 seat with
`--metric-seat validator --with-playwright` and a probe prompt. Prove, from `validate.log`:
1. Playwright actually loaded in-cage — a `browser_navigate` to `http://127.0.0.1:8799/factory/`
   succeeds (the thing that was structurally impossible before F9).
2. The seat returns a **snapshot-derived** finding about the real board (e.g. reports the
   Histórico completion tiles / a ⓘ reveal), not a guess — proving GLM-5.2 can drive Playwright
   end-to-end (never observed before; `glm-cage-briefing §3e` flagged its tool-use fidelity as
   unproven — this run is the proof or the disproof).
3. The canary deny bites: from inside the seat, a `Read`/`cat` of the planted
   `~/.config/amiticia/CANARY` is refused (tool-path closed); the documented python-bypass is NOT
   exercised (Tier-A residual, accepted).
If GLM-5.2 proves unreliable at driving Playwright in V3, that is a finding to surface to André,
not a silent PASS — the fallback (coordinator drives the probe) is named in `validation.md`.

## Out of scope
Tier-B kernel-hard secret isolation (dedicated unix user / ai-jail); wahub visual-validation
(when added, it MUST extend product-`.env` denies for its worktree); board-report changes; the
VPS republish (coordinator, after André's OK); M6 routing.

## Handoff note
This mission is the meta-fix that makes every *future* UI mission's validation independently
eyes-on. After F9 lands and V3 proves GLM-5.2 can drive, retrofitting F1–F8's visual checks to
run as caged GLM validators (instead of coordinator-driven) becomes possible — but is not part of
F9.
