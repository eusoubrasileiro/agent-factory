# Mission Brief — factory-profiles

**Requirements:** none (factory-internal; v2.2 plan §W-A)

## Problem

The factory engine was extracted from wahub, but wahub *facts* stayed baked into
generic engine *files*: the three mission skills hardcode `missions/wahub/` and the
wahub gate commands; the cage template hardcodes wahub's Critical-File list; the
external-seat env template hardcodes wahub's env shape; an engine test asserts on
wahub's files. Onboarding a second product today means editing engine internals.

## Who it serves

Andre, as the owner of a factory that must serve agendazap and future verticals —
not just wahub. Every hour of "adapt the engine" per new project is an hour not
spent on product. The engine is AmiticIA's production capacity; coupling debt taxes
every future project.

## Outcome — what "good" looks like

The engine knows the **shape** of a project; only a **profile** knows the **facts**.
`projects/<id>/` carries `project.json` (gate commands, trunk, paths),
`critical-files.json` (feeds the cage), `seat.env` (dummy secrets), and
`validation.md` (per-project behavioral playbook — WABA probes and the like).
`grep -rn "wahub" scripts/ templates/ skills/` returns **zero** lines, and a
conformance test suite fails loudly the moment a product literal creeps back in.
Nothing is lost: the wahub prose moves address, verbatim.

## Out of scope / do not touch

- The cage's Tier A/B sandbox gating (that is mission `factory-cage-usable`, W-B).
- `standards/` documentation (mission `factory-standards-doc`, W-C).
- Any agendazap profile (mission `factory-second-project-proof`, W-D).
- Any wahub product code. The single wahub file touched is
  `scripts/dispatch-worktree.sh` (F7, coordinator seat only — secrets-handling).

## Notes / constraints

- Ratified by Andre 2026-07-09 via plan approval; full plan:
  `docs/plan-v2.2-generic-engine.md`.
- `resolveProject` must stay **TOTAL** — a missing/corrupt profile yields defaults,
  never a throw. Every side channel stays soft-fail.
- Engine test harness is `node --test` over the flat glob `scripts/*.test.mjs`,
  **not vitest**. A test placed outside that glob is silently never run.
