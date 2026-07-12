# Plan A — `ship-truth`: the factory learns what it shipped and what it cost

> **Audience: an Opus coordinator agent leading builder seats.** Over-specified on purpose:
> execute and verify, don't re-derive. When this doc and reality conflict, STOP and escalate
> to Andre. Re-verify every file:line against main before building on it.
>
> **Provenance.** Authored 2026-07-11 by the Fable 5 planner from four parallel research
> agents (cost analysis, intake traceability, board consistency, validation survey) run
> against factory main @ `74b9379` + wahub main, plus planner-verified git ground truth.
> Sibling plans: `plan-B-board-legibility-2026-07-11.md`, `plan-C-validation-bundle-2026-07-11.md`.
> Plan A is the prerequisite of Plan B (B renders what A records). Standing findings doc:
> `enhancements-2026-07-09.md` — referenced below as **E-doc**; its §0 prime directive
> (*DO NOT SLOW THE FACTORY DOWN*), §0.1 carve-out ritual, §0.2 seat rule, and §7
> verification ritual are **binding here verbatim**.

## Why (business) — the headline finding

The factory's records understate its output while understating its cost — both halves of
the cost-per-delivered-feature KPI are broken, in opposite directions:

- **Output**: `history.jsonl` terminal states say 4/30 missions Done. Git ground truth
  (verified by the planner on wahub main): **at least 12 mission branches merged** —
  PRs #51–#56 (`conv-lock-void`, `contact-intent-label`, `sdr-nonlead-gate`,
  `tenant-a-config-leak`, `contact-name-backfill`, `lead-created-date`), plus `message-origin`
  (`395a2bf`), `gold-eval-viewer`, `coex-history-mine` (`5868b59`), and the three
  factory-extraction missions. Cause: `deriveMissionState` reports Done **only** on a
  `RATIFIED` dossier marker; nothing writes it on merge. The factory has no idea its own
  work is in production.
- **Cost**: `stats.json` carries `tokens.total = 0`/null models on 5 of 9 missions
  (E-doc E1-d fail-open); `pr` is null in every `stats.json` (no denominator);
  attention-per-feature — the KPI RUNBOOK §"Measure it" says decides whether the factory
  lives — logged 5 touchpoints / 3 interventions / 0 escalations across 16 missions'
  `metrics.jsonl`, i.e. effectively uncollected; coordinator (Opus) transcripts for the
  productive Jul 8–10 burst are not retained under `~/.claude/projects/`.
- **Freshness**: the published board (`dist/factory-board/wahub/index.html`,
  generatedAt 2026-07-11 22:27:01) was rendered **14 seconds before** the intake source
  was last written — Andre's Wed–Sat intakes exist and chain correctly in the live model
  (42 rows, 12 chains) but the public board shows the pre-burst snapshot ("18 captados ·
  0 despachados").

Andre's open question — *is the factory cheaper than direct Claude Code sessions?* — is
currently **unanswerable from data**. This plan installs the three missing instruments:
the merge ledger (denominator), working stats/metrics (numerator), fresh publish. Judging
the factory stays Andre's call; this plan only makes the meter honest.

## Preconditions (every session, §0.1 ritual)

```bash
git -C <factory> status --short && git -C <factory> worktree list
git -C <wahub> status --short && git -C <wahub> worktree list
```
Treat anything dirty/branched as owned by another session. `history.jsonl`,
`missions/wahub/**` are other sessions' state: read, never write by hand (F1's backfill
writes marker files through the new tool only). Seat rule: files on
`projects/factory/critical-files.json` (notably `verdict.mjs`, `ratify.mjs`, `metrics.mjs`,
`lib/project.mjs`, `templates/**`, `projects/**`, `decisions.md`) are
**[coordinator-seat]**; everything else goes to caged builders
(`claude-worker.mjs --project factory`, marker caveat per D-27 until E4-a lands).

## F1 — merge reconciler + ships ledger (the missing denominator) — HIGHEST VALUE

New engine script `scripts/mission-reconcile.mjs` (product-agnostic, profile-driven —
zero product literals, `lib/project.mjs:32-35` rule):

- For each mission slug under `missions/<project>/`, resolve the profile
  (`resolveProject`), compute the branch name `<profile.branchPrefix><slug>`, and ask the
  product repo: is it merged into `<profile.trunk>`?
  `git -C <repo> branch -r --merged <trunk>` + `git log --oneline <trunk> --grep`
  fallback for squash/message merges (e.g. `coex-history-mine` merged via message-tagged
  commit `5868b59`, not a PR). Record method used.
- On merged: (a) append one line to a new root ledger `ships.jsonl`
  `{ts, project, slug, branch, mergeSha, pr, trunk, method}` (PR number parsed from the
  merge-commit subject when present, else null — never fabricated); (b) write a `MERGED`
  marker file in the dossier (same mechanism family as `RATIFIED`). **Idempotent**: an
  existing marker + ledger line for the same mergeSha → no-op.
- `deriveMissionState` (`board-sync.mjs`) gains: `MERGED` marker ⇒ Done (display may say
  "Shipped" — Plan B's concern). `RATIFIED` keeps meaning "Andre approved"; `MERGED`
  means "trunk has it". Both can hold; git is the stronger fact.
- `mission-stats.mjs` stamps `pr`/`mergeSha` from the ledger when present.
- **Backfill run** over all existing wahub missions is part of this feature's
  verification: after `pnpm mission:reconcile --project wahub`, the six PRs #51–#56
  missions + `message-origin` + `gold-eval-viewer` + `coex-history-mine` must show
  Done/Shipped and appear in `ships.jsonl` with real SHAs.
- Wire into `board-autopublish` pre-render (reconcile, then render) so the board can
  never again show a merged mission as waiting.

Failure discipline (D-25 doctrine): git unreachable / unknown trunk ⇒ **report and skip
loudly, exit non-zero on `--strict`** — never a silent empty reconciliation.

**Contract assertions** (write `missions/factory/ship-truth/contract.md` BEFORE code):
(1) fixture repo with a merged + an unmerged branch → exactly the merged slug gets marker
+ ledger line; (2) squash-merge (no branch ref survives) detected via grep fallback;
(3) re-run → zero new ledger lines (idempotency); (4) git failure → non-zero, ledger
untouched; (5) after backfill, `board-sync` derives Done for `contact-intent-label`
(currently frozen Needs Human with a merged PR #52). **Mutation gate:** make the merged
check always-false → assertions 1 and 5 named-red.

## F2 — execute E-doc mission E1 (`publish-funnel-failopen`) as scoped there

E1-b/c/d/e/f exactly as written in `enhancements-2026-07-09.md` §1 (E1-a is FIXED on
main — regression-test-only). Do not re-scope here; that section is already
execution-grade. E1-d is what zeroed 5 of 9 `stats.json` — it is the numerator half of
this plan's KPI repair.

## F3 — publish freshness (the 14-second lie)

- `intake-server.mjs` (local edit server): every successful save triggers autopublish
  (reuse `triggerAutopublish` / `board-autopublish` entry, debounced ~30 s) instead of
  only on explicit `--publish`. Verify against main: the save path is around
  `intake-server.mjs:234` (`landedIn` edit handler).
- `board-autopublish.mjs` self-check: after render, if any source file's mtime >
  render-start, re-render once (bounded, no loop). Stamp both `generatedAt` and
  `dataAsOf` (max source mtime) into the payload — Plan B renders the staleness banner.
- Serialize with E1-f's lockfile (same critical section — coordinate if E1 runs in a
  parallel worktree; prefer landing E1-f first).

**Contract:** save via intake-server → published HTML contains the new row within the
debounce window (stub rsync per D-32 test style); mtime-race test → exactly one re-render.

## F4 — coordinator attention + token accounting (the missing numerator)

The expensive layer (Opus coordinator + Andre's attention) is the unmeasured one. Two
mechanisms, **automatic-first** (a meter that costs attention defeats itself):

- **Token side**: new `scripts/session-cost.mjs` — reads
  `~/.claude/projects/<workdir>/*.jsonl`, sums per-message `usage` fields by day/model,
  optional `--mission <slug>` tag via a session-start convention (skills emit one
  `metrics.jsonl` `session` event carrying the session id; the tool joins on it).
  Report-only, no daemon. Also: determine why Jul 8–10 transcripts are gone — check
  `cleanupPeriodDays` in `~/.claude/settings.json` and RUNBOOK-document the retention
  requirement (raise it; the KPI needs ≥30 days).
- **Attention side**: the three skills (`mission-plan`, `mission-build`,
  `mission-validate`) each append their existing metrics events at their gate points —
  verify the emitter calls actually exist in the skill texts and fix where the skill
  narrates but never commands the `pnpm metrics` call (that's why totals are 5/3/0).
  Keep events to gate moments only (dispatch, handoff-review, verdict, ratify) — no
  fine-grained logging.
- `metrics.mjs`/`verdict.mjs` per-line corrupt-tolerance lands via E1-e.

**Contract:** a scripted fake transcript dir → `session-cost` totals match hand-sum;
skill texts grep-assert one emitter command per gate (meta test, same style as the
zero-product-literals check).

## F5 — KPI readout: one honest table

Extend `metrics.mjs summary` (or a new `pnpm kpi`) to print, per project and window:
missions merged (from `ships.jsonl`) · seat tokens (metrics.jsonl) · coordinator tokens
(session-cost, where retained) · touchpoints/interventions/escalations per merged
mission. Explicit `—` for unmeasured cells, never zero-filled (the E1-d lesson:
**a metric that can't be measured must render as absent, not as 0**). This table is the
artifact Andre reads to answer "is the factory worth it" after the next batch.

## Verification ritual — E-doc §7 applies in full

Contract before code; re-run every CLI verification yourself; mutation-test every guard;
`pnpm test` green on main before/after; zero product literals in `scripts/`; one
`decisions.md` line (Portuguese, coordinator-authored) per hard-to-reverse choice —
expected: one for the `MERGED` marker semantics vs `RATIFIED`, one for transcript
retention policy.

## Ratified decisions (2026-07-11 — Andre delegated these calls to the planner; recorded in `decisions.inbox.md`)

1. **`MERGED` ⇒ board Done, automatically.** Data: 12 missions merged while their ratify
   step never ran — ratify-as-display-gate is already dead in practice; git is truth and
   the board must never contradict it. `RATIFIED` stays as a recorded blessing, and
   ratification remains MANDATORY where it always really was: hard-to-reverse actions
   (prod PATCHes/migrations — D-45/D-46 class), never as a display gate. A merged mission
   without `RATIFIED` renders Done with a small `não ratificado` flag, not blocked.
2. **Transcript retention: set `cleanupPeriodDays: 90`** in `~/.claude/settings.json` on
   BOTH machines (z390m + predator). Root cause of the missing Jul 8–10 numerator is
   cross-machine, not expiry — those coordinator sessions ran on predator; `session-cost`
   must therefore print which machine's transcripts it reads and aggregate per-machine;
   the mission-tag `session` event (F4) is what makes the cross-machine join possible.
3. **Attention accounting = gate-moment events only** (dispatch, handoff-review, verdict,
   ratify). Anything finer is rejected: a meter that costs attention defeats its purpose.
