# Brief — factory-cage-usable (W-B of Factory v2.2)

## The finding that reshapes this mission

**The cage is not installed.** `scripts/cage-settings.mjs` renders a correct, audited
Claude Code cage, and nothing calls it:

- `grep -rn "writeCageSettings|cage-settings|settings.external"` across the factory →
  only its own tests and the plan doc. **Zero production callers.**
- `products/wahub/scripts/dispatch-worktree.sh` → zero matches for cage / permission /
  settings.external.
- `cage-settings.mjs`'s own header says it is "written FRESH at every spawn by
  `claude-worker.mjs`". **`claude-worker.mjs` does not exist** — it is W-B F3, unbuilt.
- The only driver we run is `opencode-worker.mjs`. **opencode does not read Claude Code's
  `.claude/settings.external.json` schema at all.**

So, for the GLM/opencode builder seat that actually does our work:

| Control | Status today |
|---|---|
| dummy `.env` in the worktree (W1) | **real** |
| `buildSpawnEnv` allowlist (no vendor secrets reach the child) | **real** |
| worktree routing (`FACTORY_WORKTREE_MARKER`) | advisory |
| Edit/Write deny on the profile's Critical Files | **not enforced** |
| `Bash(git push)` deny | **not enforced** |
| `Read(~/.ssh)`, `Read(~/.config/amiticia)` deny | **not enforced** |
| OS sandbox | **not enforced** |

**The T1 incident that motivated the whole cage — a worker editing `backend/src/bot/graph.ts`
after being told not to — is still fully possible today.** The v2.2 plan's Tier A ("always
on, zero productivity cost") describes an intent, not the running system.

## Why the plan missed it

The plan assumed W-B F3 (`claude-worker.mjs`) would activate the cage. That is circular:
the cage only bites if the builder seat IS Claude Code, and switching the builder to a
caged-CC seat is the **deferred A/B** whose spend is Andre's call. The cage's activation
was therefore blocked behind a deferred decision, while the running seat stayed uncaged.

## The cheap fix the plan missed

opencode has a native permission system (verified against opencode v1.17.15 via context7 —
`opencode.ai/docs/permissions`, `opencode.ai/docs/config`):

```json
{ "permission": { "bash": {"*":"allow","git push *":"deny"},
                  "edit": {"*":"allow","backend/src/bot/**":"deny"} } }
```

Last matching rule wins. Config discovery: project `opencode.json` (highest precedence) or
`$OPENCODE_CONFIG` (custom path, between global and project).

The same `projects/<id>/critical-files.json` that feeds the CC cage can feed an
**opencode-native cage**. One profile, two renderers. That contains T1 for the seat we
actually run, today, without touching the deferred model/driver A/B.

## Re-ordering (deviation from the ratified plan — Andre ratifies)

By real risk reduction, not by plan order:

1. **Graceful kill** — `SIGTERM → 30 s grace → SIGKILL`. Pure bug fix, no decision.
   `opencode-worker.mjs:307` sends a bare `SIGKILL`; we reproduced the resulting
   near-miss on `factory-profiles` F2 (worker committed, then hung, then was killed).
2. **`cage-opencode.mjs`** — renders opencode's permission config from the profile.
   *This is what makes Tier A true for the seat we run.* **New; not in the plan.**
3. **`probe-cage.mjs`** — planted-prompt adversarial probe against the DEFAULT driver,
   asserting on **filesystem ground truth** (D-11d: `permission_denials` returns `[]`
   even when a deny fires). Coordinator-authored: a seat must never write its own
   containment proof (C3).
4. **`claude-worker.mjs` + Tier A/B machine gating** — kept in the plan, moved LAST.
   They serve the deferred A/B. Building them first is gating a consumer that does
   not exist.

## Business value

The factory's value is attention-per-feature. A cage that isn't installed spends zero
productivity and buys zero safety — it only buys the *belief* in safety, which is worse
than knowing you are uncaged. Item 2 costs the seat nothing measurable and makes the one
observed failure mode impossible. Item 1 stops losing work.
