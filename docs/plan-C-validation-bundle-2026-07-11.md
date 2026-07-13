# Plan C — `validation-bundle`: per-project behavioral validation as a first-class profile fact

> **Audience: an Opus coordinator agent leading builder seats.** Execute and verify; STOP
> and escalate on doc-vs-reality conflict. Re-verify every file:line against main.
> Independent of Plans A/B (parallelizable in its own worktree). Implements the
> **E-doc §E-appendix** enhancement (filed 2026-07-10, verified untouched since —
> no commit, mission dossier, or grep hit toward it as of `74b9379`).
>
> **Provenance.** 2026-07-11, Fable 5 planner; structural survey by a Sonnet agent over
> the seat drivers, dispatch script, profiles, skills, and templates. E-doc
> §0/§0.1/§0.2/§7 binding — especially §0 rule 2: **every hardening/wiring change ships
> with a usability CONTROL assertion**.

## Why (business)

Unit/E2E gates prove code shape; they don't catch "the bot replied nonsense", "the board
dropped a lead", "the UI is broken for a real user" (workspace CLAUDE.md, Behavioral
Validation). Today that catch exists **only inside the coordinator's own session** — the
single most expensive seat and the one Amdahl bottleneck — because:

- The `mission-validate` skill *assumes* the validator can run MCP probes
  (`SKILL.md:34-57`: "which MCP probe covers chat, which UI target playwright drives")
  **and** offers running the validator on the external GLM seat (`SKILL.md:44-57`) —
  but there is **no code path that can carry an MCP server into a dispatched seat**:
  `claude-worker.mjs` builds the child env from an allowlist
  (`PATH/HOME/LANG/…` + `ANTHROPIC_*`, `claude-worker.mjs:73-82,197-204`;
  `opencode-worker.mjs:151-166`) and invokes `claude -p --settings <cage>`
  (`claude-worker.mjs:263-270`) — a fresh non-interactive process that inherits nothing
  from `~/.claude.json`. A coordinator following the skill literally dispatches a
  validator that either errors or — worse — **silently skips the assertions it cannot
  prove and reports PASS**.
- **No per-project declaration exists**: `buildProfile()` returns only
  `{gate, trunk, branchPrefix, criticalFiles, seatEnvPath, validationPath, intake}`
  (`lib/project.mjs:140-182`). `validation.md` is prose for humans; the engine can't act
  on it. Nothing says "wahub validates with playwright+whatsapp+supabase" in a form
  dispatch can execute.
- **The supabase MCP is registered nowhere** — not even in Andre's own `~/.claude.json`
  (confirmed; servers present: whatsapp, playwright, langsmith, docs-langchain,
  amiticia-research, context7, audio-transcriber).
- NOT a model limitation (E-appendix, Andre verbatim): GLM-5.2 drives
  playwright/whatsapp/supabase MCPs fine. The harness never hands them over.

Value: **validation parallelizes** (N missions validate concurrently on cheap seats
instead of serializing through Opus), and behavioral validation becomes a per-project
default instead of a coordinator habit — the "critical step not properly set" Andre named.

## F0 — DB validation: scratch-DB scripts now, DB MCP later [RATIFIED — see §Ratified]

No supabase MCP prerequisite. Wahub already carries `@supabase/supabase-js`
(`backend/package.json:45`), a `test:e2e:supabase` harness (`package.json:15`,
`scripts/e2e-supabase.sh`), and every dispatched worktree gets its own scratch
`DATABASE_URL`/`DIRECT_URL` in `.agent-env` — DB-state assertions run as plain
scripts/Prisma queries against the seat's own scratch DB, isolated by construction.
A read-only Postgres/Supabase MCP becomes just another **registry entry** (F2) a project
can declare later; the extensible schema below means enabling it is a one-line
`project.json` change, zero engine edits. **Never declare a capability whose backing
doesn't exist** (D-37 lesson: absent target = silent fail-open) — the conformance suite
enforces this.

## F1 — profile schema: extensible `validation` object [coordinator-seat: `lib/project.mjs`, `projects/**`]

Andre's directive: validation rules are project-specific and the factory must be ready
for "much more" than the three tools named. So the profile field is a **capability list,
not an MCP list** — each entry one of three kinds, all engine-generic:

```jsonc
// projects/wahub/project.json
"validation": [
  { "kind": "mcp",   "name": "playwright" },              // F2 registry → --mcp-config
  { "kind": "mcp",   "name": "whatsapp" },                // test-eSIM session only (§Ratified 2)
  { "kind": "cmd",   "name": "db-state", "run": "pnpm test:e2e:supabase" },  // scratch-DB scripts
  { "kind": "brief", "name": "adversarial-ui", "template": "validator-adversarial-ui" }
]
```

- `kind: "mcp"` → resolved through F2's registry, rendered into the seat's
  `--mcp-config` with worktree-scoped placeholders.
- `kind: "cmd"` → a named proof command the validator runs inside the worktree (env
  from `.agent-env`); how wahub's DB assertions work today, promoted to declared config.
- `kind: "brief"` → a `templates/validator-*.md` section injected into the validator
  brief (F5's adversarial-UI pass is the first; future: load probes, a11y, LGPD checks —
  whatever a project needs, added without touching the engine).
- `buildProfile()` gains `validation: []` (default empty, total/never-throw, same
  discipline as `criticalFiles`). Conformance suite pins: every `mcp` name resolves in
  the registry, every `brief` template file exists, every `cmd` is non-empty — **unknown
  ⇒ profile load fails** (fail-closed).
- tenant-c: `[]` today — its own `validation.md:19-23,45-51` honestly documents no
  driveable surface yet.

## F2 — server-definition registry + worktree-scoped render [builder + coordinator-seat for `templates/**`]

- New `templates/validation-mcp.json` — engine-owned catalog mapping server name →
  launch spec (`command`, `args`, env **placeholders**: `{{FRONTEND_PORT}}`,
  `{{BACKEND_PORT}}`, `{{DATABASE_URL}}`, `{{WORKTREE}}`). No product literals — ports
  and DB come from the seat's `.agent-env`, already computed by
  `dispatch-worktree.sh:168-199` and written at `:285-300`.
- New engine module `scripts/lib/validation-mcp.mjs`: `renderMcpConfig(profile, agentEnv)`
  — consumes the profile's `validation[]` entries of `kind:"mcp"` — writes
  `<worktree>/.claude/validation-mcp.json` with placeholders resolved to THIS
  worktree's ports/DB — a seat's playwright `baseURL` must point at its own stack, never
  a shared one (isolation is what makes parallel validation safe).
- `dispatch-worktree.sh` gains `--validation`: renders the file alongside `.agent-env`.
  Update the wahub copy; note E-doc E4-e (engine-shipped dispatch template) as the
  durable home when it lands — do not block on it.

## F3 — driver plumbing: hand the bundle to the seat [builder: `claude-worker.mjs`, `opencode-worker.mjs`]

- `claude-worker.mjs` gains `--validation-mcp <path>` (or auto-detect the rendered file
  when `--seat validator`): passes `--mcp-config <path>` to the `claude -p` invocation
  and extends the env allowlist with only the specific keys the rendered config needs.
  **Gated: absent flag ⇒ byte-identical behavior to today** — build seats stay lean and
  the cage's blast radius doesn't grow by default (E-appendix requirement).
- Risk scaling (§0): the bundle rides on validator seats that already sit inside the
  cage (critical-file denies, no push). Servers are drive/read-class (browser against
  localhost, test-eSIM WhatsApp, scratch-DB reads). The one write-capable surface —
  WhatsApp sends — is confined to the test number (Amiticia 2 / `demo@wahub.local`);
  assert in F5 that the rendered config carries the test session, and add the real
  client numbers to the deny surface if the server supports scoping.
- Same flag for `opencode-worker.mjs` **only if** opencode supports per-run MCP config —
  verify against current opencode docs (context7) first; if unsupported, document
  "validator bundle = claude-worker only" in RUNBOOK and skip (claude-worker is the
  default external seat anyway, D-19).

## F4 — validator seat template + skill truth [coordinator-seat: `templates/**`, skills]

- New `templates/validator-brief.md`: how a validator seat starts (read `contract.md` +
  `projects/<id>/validation.md`; enumerate its MCP tools FIRST and diff against the
  profile's declared `validation[]` capabilities; **any contract assertion whose proof
  names a capability the seat does not actually have ⇒ that assertion FAILS, and the
  verdict cannot be PASS** —
  fail-closed, never silent-skip). This kills the false-PASS footgun.
- `skills/mission-validate/SKILL.md` §3a rewrite: external validator = 
  `claude-worker.mjs --project <id> --seat validator --validation-mcp <rendered>`;
  state exactly which MCPs the seat has and the fail-closed rule. (Coordinate with E-doc
  E5 item 4, which rewrites the same section for seat-driver routing — land as one edit
  if both plans run.)

## F5 — adversarial Playwright as the web-project default + live probe [builder]

- **Default**: any profile declaring the `playwright` capability gets, in its
  validator brief, a mandatory adversarial UI pass (the `kind:"brief"`
  `adversarial-ui` entry in F1's example) — not happy-path clicking: try to
  break the flow the mission touched (empty/garbage inputs, double-submits, back-button,
  wrong-role access, the mission's own edge cases from `contract.md`), screenshot
  evidence per finding. Template section in `validator-brief.md`, parameterized by the
  profile's frontend URL (from `.agent-env` ports).
- **Live probe** (D-22 benign-twin style, extends the probe family): dispatch a real
  caged seat with the bundle; assert from filesystem/transcript ground truth (D-23) that
  (1) the seat can list its MCP tools and they match the profile, (2) playwright
  actually navigates to THIS worktree's `FRONTEND_PORT`, (3) a seat WITHOUT the flag has
  zero MCP tools (the gate holds), and — **usability CONTROL, mandatory, first in the
  list (§0 rule 2)** — (4) the profile's `gate[0]` (`pnpm test`) still runs unchanged in
  a bundled seat. A bundle that breaks normal work is a defect equal to a breach.
- Real-world acceptance (workspace CLAUDE.md behavioral-validation rule): one wahub
  mission validated end-to-end by a GLM seat — whatsapp MCP send on the test eSIM →
  bot reply asserted; playwright asserts the inbox rendered it — with the coordinator
  only reading the verdict.

## Verification ritual — E-doc §7 in full

Contract before code (the F5 probe list IS the contract spine); coordinator re-runs every
CLI proof; mutation gates: remove the fail-closed tool-diff from the validator brief →
false-PASS fixture named-red; point the registry render at a wrong port → probe (2) red;
un-gate the flag → probe (3) red. Suite green before/after; zero product literals in
`scripts/`/`templates/`; `decisions.md` lines expected: bundle-gated-by-flag (why),
fail-closed validator doctrine, supabase server registration.

## Ratified decisions (2026-07-11 — Andre delegated; grounded in wahub data + KB research; recorded in `decisions.inbox.md`)

KB research run per the knowledge protocol (amiticia-research, 2026-07-12 retrieval,
medium confidence): behavioral validation as a distinct phase with **declarative
per-project capability config** is current practice (Augment 2026-04-12; CodeSignal
2026-06-07); `claude -p --mcp-config` is the sanctioned provisioning path into headless
seats (Anthropic, effective-harnesses, 2025-11-26); on DB validation the sources favor an
MCP for *isolation in multi-agent environments* — an argument wahub already satisfies
with per-worktree scratch DBs, hence the hybrid below.

1. **No supabase MCP now.** DB assertions = `kind:"cmd"` scripts against the seat's own
   scratch `DATABASE_URL` (existing `test:e2e:supabase` machinery — zero new infra, zero
   new creds surface, isolation by construction). A read-only DB MCP is pre-approved as a
   future F2 registry entry the day a validator needs ad-hoc introspection instead of
   pre-written assertions — one-line project.json change, no engine edit, no new ratify.
2. **WhatsApp blast radius — HARD RULE**: bundle validators send ONLY on the test eSIM
   (Amiticia 2, <test-esim-2> / `demo@wahub.local`). The rendered MCP config pins the
   test session; client numbers never reachable from a seat. F5's probe asserts the
   rendered config carries no other session. (Real phone network + Meta ToS surface —
   treat a violation as a breach, same severity class as a cage escape.)
3. **Default-on for behavioral missions, never for build seats.** Mechanically: if a
   mission's `contract.md` contains behavioral assertions (any proof naming an F1
   capability), the validate-phase dispatch renders the bundle automatically; contracts
   with none skip it. Build seats never get it. This encodes the workspace rule
   ("exercise customer-facing flows before declaring done") as harness behavior instead
   of coordinator memory; GLM seat tokens are flat-plan, so the marginal cost is
   wall-clock only — acceptable.
