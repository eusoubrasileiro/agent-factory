# RESUME — morning priorities (filed 2026-07-11 night)

**Do these in the morning, not now.** Three execution-ready plan dossiers, written for Opus
coordinator agents, all ratified (no open questions — decisions delegated by Andre and
recorded in `decisions.inbox.md`). They fix the three things Andre flagged this session:
the board can't be trusted, intakes can't be tracked, and validation is missing.

## Context in one paragraph

Andre doubted the factory is worth its cost vs. driving Claude Code directly. Investigation
(4 parallel research agents + git ground truth) found the honest answer is **the meter is
broken, not the factory**: git shows ≥12 missions merged to wahub main (PRs #51–#56,
`395a2bf`, `5868b59`, gold-eval-viewer, factory-extract×3) while `history.jsonl` says only
4 Done — nothing writes a Done marker on merge. Meanwhile `stats.json` is zeros on 5/9
missions (E1-d fail-open) and the Opus coordinator's real-cost tokens for the productive
Jul 8–10 burst were never retained. The board Andre reads is a stale snapshot rendered
14 s before his Wed–Sat intakes were saved. So: output is understated, cost is unmeasured,
and the tracking layer — the factory's whole reason to exist — is what's failing. Fix the
instruments before judging the factory.

## The three plans (priority order)

| # | Plan | Fixes | File |
|---|------|-------|------|
| A | **ship-truth** | merge/PR ledger (`ships.jsonl`) + Done-on-merge, E1 fail-opens, publish-on-save, coordinator cost/attention KPI | `docs/plan-A-ship-truth-2026-07-11.md` |
| B | **board-legibility** | intake→PR chain repair (`landedIn`, tolerant parsers, C8 collision), split "Needs Human" ×3, kill "Intake" name clash, reconcile with `factory-process.md` | `docs/plan-B-board-legibility-2026-07-11.md` |
| C | **validation-bundle** | per-project `validation[]` config (mcp/cmd/brief), adversarial Playwright default, whatsapp/DB probes into caged seats, fail-closed validator | `docs/plan-C-validation-bundle-2026-07-11.md` |

## How to run

- **A and C are independent — run both in parallel** (separate worktrees, disjoint files).
- **B waits on A-F1** (the ships ledger it renders).
- **Fastest visible win**: A-F1's backfill + republish alone un-stales
  factory.example.com and shows the 12 merged missions as Done. Start there.
- Each plan is self-contained: seat assignments (coordinator-seat vs caged builder per
  `projects/factory/critical-files.json`), contract assertions, mutation gates, and the
  E-doc §0/§0.1/§0.2/§7 rituals declared binding. Hand a plan file to an Opus coordinator
  and it can execute without re-deriving.

## Also decided this session (in `decisions.inbox.md`, un-numbered — first coordinator numbers them)

- MERGED ⇒ Done; `RATIFIED` stays a recorded blessing, mandatory only for hard-to-reverse
  prod actions (D-45/D-46 class).
- Board vocab (PT): `Sem contrato` / `Aprovar plano` / `Aprovar merge` / `Escalado`; Corpo
  A–D stays (it's the ledger's working vocabulary).
- Validation: `validation[]` extensible config, fail-closed; no supabase MCP yet (scratch-DB
  `cmd` proofs instead); validator WhatsApp = test eSIM only (hard rule); bundle default-on
  only for missions with behavioral assertions.
- E-doc §8: gate-config hardening option (b) — `vitest.config.*` + `.github/**` become
  Critical Files, `package.json` stays out; verdict↔contract stays as-is, boundary documented.
- Machine setting (already applied, not in this repo): `cleanupPeriodDays: 90` in
  `~/.claude/settings.json` on z390m — **predator still needs the same one-line change** so
  coordinator transcripts (the real-cost numerator) survive for the KPI.

## Standing reference

The durable findings doc `docs/enhancements-2026-07-09.md` (missions E1–E6) is still valid
and untouched; these three plans extend it. Plan A executes its E1 verbatim.
