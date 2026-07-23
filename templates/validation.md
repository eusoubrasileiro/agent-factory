# <project> — Behavioral Validation Playbook

> **Scaffold for onboarding step 5 (RUNBOOK).** Per-project facts; the engine never
> hardcodes any of this. The validator seat (`skills/mission-validate`) reads this
> file for the project under validation. Deterministic gate commands live in
> `project.json → gate[]`; this file covers what tests cannot.

## Deterministic gate

Commands are the `gate[]` array in `project.json`. Any non-zero exit → **FAIL**
immediately; report which and stop.

**House standard (every project):** `gate[]` MUST include the project's canonical
`pnpm test:e2e`, and that command MUST include the project's **real-infra layer**
(real database / auth / RLS — whatever the product actually runs on). Mocked-green
alone is never "done": mocked units pass SQL that the real database rejects
(enum/type casts, RLS). A project with genuinely no infra surface declares
`"noCanonicalE2E": "<reason>"` in `project.json` instead — the conformance suite
enforces one or the other.

## Contract assertions — proof mechanisms by kind

For each assertion in the mission's `contract.md`, run its proof on the **local**
stack. An assertion with no green proof → that assertion FAILS.

### data / backend
The canonical `pnpm test:e2e` (must include the real-infra layer — see above).

### chat / messaging (if the product has a chat surface)
The relevant MCP probe (e.g. `whatsapp`): send a real message to the **designated
test number only** and assert the stored/observed effect. Name the test number and
the numbers that are off-limits here.

### frontend / UI (if the product has a UI)
**`playwright`**: drive the real served build, assert the visible behavior. Say
"None." if there is no UI surface, and why the deterministic gate suffices.

## Standing rules for this project

- 99% is a failing grade on anything security/RLS — adversaries retry forever.
- Note any serialization constraints (shared local stacks, shared test accounts).
- Note any commands that cost real money or touch live vendors, and where they may
  NOT run (e.g. external dummy-env worktrees).
