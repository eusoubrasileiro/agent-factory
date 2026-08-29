# factory — Behavioral Validation Playbook

> The engine is itself a project (dogfood). Missions that change the engine run
> with `--project factory`; dossiers land in `missions/factory/<slug>/`.

## Deterministic gate

`project.json → gate[]`, run with `cwd` = the factory repo root:

```bash
pnpm test    # FACTORY_AUTOPUBLISH=0 FACTORY_PR=0 node --test "scripts/*.test.mjs" "projects/*/*.test.mjs"
```

Any non-zero exit → **FAIL**.

## Behavioral probes

The engine has no chat surface and no live vendor calls, **but it does have a UI**: the
board (`scripts/board-report.mjs` → per-project HTML). `node --test` proves the HTML
*string* contains a substring; it does **not** prove a viewer can *see or use* the thing.
That gap shipped real regressions (2026-07-14: KPI "hover definitions" were native `title=`
— invisible on hover, dead on mobile; a staleness banner and a contradiction-lint chip were
claimed in a commit but never rendered). **Any mission that changes `board-report.mjs`,
`client-view.mjs`, or board CSS/JS MUST clear the rendered-DOM probe below — a green
`pnpm test` is necessary but NOT sufficient.**

### Probe: board rendered-DOM (Playwright)

Adversarial, from the validator seat. Drives the ACTUAL served page, asserts what a human
sees — never that an attribute string exists.

**The seat's eyes are wired (F9 cage-vision).** A caged GLM-5.3 seat reaches Playwright ONLY
when spawned `--with-playwright`: `claude-worker.mjs` writes a Playwright-only
`<worktree>/.claude/mcp-playwright.json` and passes `--mcp-config … --strict-mcp-config`, so the
seat's *entire* MCP surface is the one browser server — the operator's other MCP servers
(whatsapp, supabase, …) are never loaded into an untrusted seat. Without the flag the seat has
NO browser (the state before F9; it is why M4's UI regressions slipped past green tests).

```bash
# 1. Render the touched project(s) from the mission worktree — pure Node, no backlog/rsync.
#    (board-report.mjs is standalone; autopublish is NOT used here — no VPS side effects.)
OUT=$(mktemp -d)
for P in factory wahub; do
  mkdir -p "$OUT/$P"
  node scripts/board-report.mjs --repo <worktree> --project "$P" --out "$OUT/$P/index.html"
done
# 2. COORDINATOR serves on loopback (detached; never binds public). The validator seat does
#    NOT self-serve — the cage denies curl/python-serve; the coordinator holds the server.
setsid nohup python3 -m http.server 8799 --bind 127.0.0.1 --directory "$OUT" \
  >/tmp/board8799.log 2>&1 </dev/null &
# 3. Spawn the GLM-5.3 visual-validator seat WITH its eyes (the F9 flag):
node scripts/claude-worker.mjs --dir <worktree> --model glm-5.3 --project factory \
  --metric-seat validator --with-playwright --prompt-file <probe-prompt> --json-out <log>
```

**Security posture (Tier A, ratified 2026-07-14 — André, risk owner).** The seat carries a
browser, so it is the one seat that could exfiltrate. Two facts make that safe *enough* for the
ratified *careless-GLM* threat model (`cage-research §6 Q1`), and the residual is disclosed, not
hidden:
- **Env is already secret-free** — `buildSpawnEnv`/`buildClaudeEnv` scrub every product secret
  (`SUPABASE_SERVICE_ROLE_KEY`, `WABA_TOKEN_KEY`, …) before the seat starts; only the z.ai creds
  remain. A browser here cannot read customer keys from its environment.
- **The tool/recognized-bash secret-read path stays denied** (`Read(~/.config/amiticia/**)`,
  `WebFetch`, `curl`/`wget`/`nc`). Plant a canary under `~/.config/amiticia/` and a seat's
  `Read`/`cat` of it is refused.
- **Residual (accepted):** a seat runs as the operator uid, so an arbitrary
  `python3 -c "open('/…/.env').read()"` still bypasses the deny rules — no OS sandbox can
  initialise on z390m (D-18/M9). Closing this kernel-hard is **Tier B** (dedicated unix user /
  ai-jail), deferred unless the threat model shifts to *malicious*. Do not pretend the deny rules
  are a boundary for secrets; they are defense-in-depth.

**If GLM-5.3 proves unreliable at driving Playwright**, that is a finding to surface to André —
NOT a silent PASS. Fallback: the coordinator drives the probe (a few Anthropic tool-calls) until
GLM reliability is established.

Then, via the `playwright` MCP (GLM-5.3 validator seat, spawned `--with-playwright`), for
**each** touched surface at **both** `browser_resize` 390×844 (mobile) and 1440×900 (desktop):

- Navigate `http://127.0.0.1:8799/factory/` and `/wahub/`; open the relevant tab.
- Assert the mission's contract claim is **visibly true**: e.g. a definition affordance is
  present AND reveals its text on hover (desktop) and on tap/click (mobile) — a bare `title=`
  attribute is an automatic **FAIL**; a banner/chip that the contract says must appear under a
  seeded condition is actually in the snapshot; a data cell reads a real value or an explained
  "—", never a bare wall of dashes.
- `browser_snapshot` (accessibility tree) is the assertion surface; `browser_take_screenshot`
  for the human-legibility judgement. Any claimed-but-not-visible element → **FAIL** with the
  snapshot as evidence.

**Parallelism (validator seats run concurrently — measured 2026-07-15).** The old
"single shared Chrome profile, run sequentially" caveat does **not** apply to caged
validator seats: `--with-playwright` writes an MCP config that launches
`@playwright/mcp@latest --isolated` (`claude-worker.mjs:375`). `--isolated` keeps the
profile **in memory** — Playwright's `IsolatedContextFactory` calls `browserType.launch()`
with **no `user-data-dir`**, so there is no on-disk profile and no `SingletonLock`. Two (or N)
`--with-playwright` seats therefore drive N independent browsers **at the same time**; fan them
out in parallel (one per surface × viewport) to keep the eyes-on regression fast. Measured
directly: two `--isolated` launches concurrent → both PASS; two persistent launches on the
**same** `--user-data-dir` → `ProcessSingleton` collision; two persistent on **different** dirs →
both PASS. The single-instance trap survives in exactly one place: the **operator's own**
`~/.claude.json` driver still uses the persistent shared profile
(`~/.playwright-mcp-profile/profile`, `[[playwright-mcp-single-instance]]`), so two *operator*
sessions still collide — but that profile is a **different** profile from every `--isolated`
seat, so a validator fleet never contends with the operator's browser either. If you ever point a
validator at a persistent `--user-data-dir` (you should not), the stale-lock fix is
`rm -f <dir>/Singleton{Lock,Cookie,Socket}` after confirming its PID is dead.

If a future engine change adds another user-facing surface, add its probe here — never to a
`skills/` file.

## Standing rules for this project

- No dependency outside `node:*` in `scripts/`. `backlog.md` is the sole devDependency
  and is used by the board only.
- Every script keeps: the `isMain` guard, a header comment with Usage + exit codes,
  and **soft-fail semantics** — a broken side channel exits 0 and never blocks a
  verdict or a ratify.
- `resolveProject` is TOTAL. A missing, empty, or corrupt profile yields synthesized
  defaults; it never throws.
- Tests are `node:test` + `node:assert/strict`. **Not vitest.** A test file outside
  the `pnpm test` globs is silently never run — check the globs when adding one.
- Isolation for engine missions is a plain git worktree under `.worktrees/` (the
  wahub `dispatch-worktree.sh` is a wahub tool and does not apply here).
- **The engine-seat worktree layout is a profile fact** (E4-a, closes D-27):
  `projects/factory/project.json` declares `"worktreeMarker": "/.worktrees/"`, and both
  drivers read it from the resolved profile — no `FACTORY_WORKTREE_MARKER` env needed.
  Engine missions also carry a lighter dossier — `contract.md` + `HANDOFF.md`, no
  `features/` tree — so the plan/build templates are not mandatory for them.
